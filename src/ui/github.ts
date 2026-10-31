/** Load a PUBLIC GitHub repo into a local cache so the UI can search it.
 * No credentials, no private repos, no non-GitHub hosts: the URL parser is
 * the security boundary and it is deliberately narrow. The clone also runs
 * with a neutralized git configuration: user/system gitconfig is ignored
 * (credential helpers, askpass programs, http.extraHeader, url.insteadOf
 * rewriting and filter drivers all live there), prompting is off, and the
 * credential helper is explicitly emptied - so a public clone can never
 * pick up ambient credentials or be redirected to another host. Retrieval
 * and indexing stay exactly what they are for a local repo: the clone is
 * just a directory Ember indexes with the same local embedder. */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

export interface GitHubRepo { owner: string; repo: string; ref?: string; cloneUrl: string; label: string; }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Branch/tag names: no spaces, no "..", no control chars; single path
// segment only (a /tree/a/b link is ambiguous - GitHub resolves it
// greedily - so we refuse rather than guess).
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const NULL_DEV = process.platform === "win32" ? "NUL" : "/dev/null";
/** Hard wall-clock bound on any single git invocation. */
const GIT_TIMEOUT_MS = 4 * 60 * 1000;

/** Parse a GitHub repo reference into its parts, or throw with the reason.
 * Accepted: github.com/owner/repo, https://github.com/owner/repo[.git][/],
 * and /tree/<branch-or-tag> (honored: that ref is cloned, never silently
 * swapped for the default branch). Anything deeper is refused. */
export function parseGitHubUrl(input: string): GitHubRepo {
  const raw = input.trim();
  if (!raw) throw new Error("paste a GitHub repo URL, e.g. https://github.com/pallets/flask");
  if (/^(git@|ssh:|file:)/i.test(raw)) throw new Error("only plain https GitHub URLs are supported - no SSH, file, or credential URLs");
  if (/[^\s]+@github\.com/.test(raw)) throw new Error("credentials in URLs are not accepted; Ember loads public repos only");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new Error(`not a URL: ${raw}`); }
  if (u.protocol !== "https:") throw new Error("only https GitHub URLs are supported");
  if (u.username || u.password) throw new Error("credentials in URLs are not accepted; Ember loads public repos only");
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com")
    throw new Error(`only github.com is supported (got ${u.hostname}); no proxy or mirror hosts`);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("URL must name a repo: github.com/<owner>/<repo>");
  const [owner, repoRaw, third, refRaw, ...rest] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (third && third !== "tree") throw new Error(`deep links (/${third}/...) are not supported - paste the repo root URL or a /tree/<branch> link`);
  if (third === "tree" && (!refRaw || rest.length > 0))
    throw new Error("branch links must be /tree/<branch> with a single-segment name; subpath links are not supported");
  const ref = third === "tree" ? decodeURIComponent(refRaw) : undefined;
  if (ref && !REF.test(ref)) throw new Error(`invalid branch or tag name: ${ref}`);
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error(`invalid owner or repo name: ${owner}/${repo}`);
  return { owner, repo, ref, cloneUrl: `https://github.com/${owner}/${repo}.git`, label: ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}` };
}

export function remoteCacheDir(repo: GitHubRepo, cacheRoot?: string): string {
  const base = cacheRoot ?? path.join(os.homedir(), ".ember", "remotes");
  const key = repo.ref ? `${repo.owner}__${repo.repo}__${repo.ref}` : `${repo.owner}__${repo.repo}`;
  return path.join(base, key);
}

export type SpawnGit = (args: string[], cwd?: string) => Promise<{ code: number; output: string }>;

/** Environment for every git invocation: user AND system gitconfig are
 * replaced with the null device (kills credential helpers, askpass
 * programs, http.extraHeader, url.insteadOf host rewriting, LFS/filter
 * drivers), terminal prompting is off, and proxy variables are left as-is.
 * Combined with `-c credential.helper=` on each call, a clone of a private
 * repo fails fast with "could not read Username" instead of prompting,
 * hanging, or silently using ambient credentials. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEV,
    GIT_CONFIG_SYSTEM: NULL_DEV,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

export const realGit: SpawnGit = (args, cwd) => new Promise((resolve, reject) => {
  const p = spawn("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv() });
  let out = "";
  const timer = setTimeout(() => {
    p.kill("SIGKILL");
    resolve({ code: 1, output: out + `\ngit timed out after ${GIT_TIMEOUT_MS / 1000}s and was killed` });
  }, GIT_TIMEOUT_MS);
  p.stdout.on("data", d => { out += d; });
  p.stderr.on("data", d => { out += d; });
  p.on("error", e => { clearTimeout(timer); reject(e); });
  p.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, output: out }); });
});

/** Clone (or refresh) a repo into the cache. Shallow, single-branch, and
 * time-bounded; no submodules are fetched and no repo content is executed
 * (git never runs hooks from a freshly cloned repo, and the neutralized
 * configuration means no filter drivers either). A failed clone removes
 * the partial cache dir so the next load starts clean. */
export async function cloneOrUpdate(repo: GitHubRepo, dest: string, log: (m: string) => void, git: SpawnGit = realGit): Promise<void> {
  const exists = await fs.stat(path.join(dest, ".git")).then(() => true, () => false);
  if (exists) {
    log(`cached clone of ${repo.label} found - fetching latest ${repo.ref ?? "default branch"}`);
    const fetch = await git(["fetch", "--depth", "1", "origin", repo.ref ?? "HEAD"]);
    if (fetch.code === 0) {
      const reset = await git(["reset", "--hard", "FETCH_HEAD"], dest);
      if (reset.code === 0) return;
    }
    log("refresh failed - re-cloning from scratch");
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = ["clone", "--depth", "1", "--single-branch", ...(repo.ref ? ["--branch", repo.ref] : []), repo.cloneUrl, dest];
  log(`cloning ${repo.cloneUrl}${repo.ref ? ` (${repo.ref})` : ""} (shallow, public repos only)...`);
  const r = await git(args);
  if (r.code !== 0) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    const tail = r.output.trim().split("\n").slice(-2).join(" ");
    throw new Error(`git clone failed: ${tail || "unknown error"} (private or missing repo? Ember loads public repos only)`);
  }
  const entries = await fs.readdir(dest);
  log(`clone complete: ${entries.length} top-level entries`);
}
