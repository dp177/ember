/** Load a PUBLIC GitHub repo into a local cache so the UI can search it.
 * No credentials, no private repos, no non-GitHub hosts: the URL parser is
 * the security boundary and it is deliberately narrow. Retrieval and
 * indexing stay exactly what they are for a local repo - the clone is just
 * a directory Ember indexes with the same local embedder. */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

export interface GitHubRepo { owner: string; repo: string; cloneUrl: string; label: string; }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** Parse a GitHub repo reference into its parts, or throw with the reason.
 * Accepted: github.com/owner/repo, https://github.com/owner/repo[.git][/],
 * and a /tree/<branch> suffix (the branch is NOT honored - default branch
 * is cloned; anything deeper is refused rather than silently misread). */
export function parseGitHubUrl(input: string): GitHubRepo {
  const raw = input.trim();
  if (!raw) throw new Error("paste a GitHub repo URL, e.g. https://github.com/pallets/flask");
  if (/^(git@|ssh:|file:)/i.test(raw)) throw new Error("only plain https GitHub URLs are supported - no SSH, file, or credential URLs");
  if (/[^\s]+@github\.com/.test(raw)) throw new Error("credentials in URLs are not accepted; Ember loads public repos only");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new Error(`not a URL: ${raw}`); }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com")
    throw new Error(`only github.com is supported (got ${u.hostname}); no proxy or mirror hosts`);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("URL must name a repo: github.com/<owner>/<repo>");
  const [owner, repoRaw, third] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (third && third !== "tree") throw new Error(`deep links (/${third}/...) are not supported - paste the repo root URL`);
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error(`invalid owner or repo name: ${owner}/${repo}`);
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git`, label: `${owner}/${repo}` };
}

export function remoteCacheDir(repo: GitHubRepo, cacheRoot?: string): string {
  const base = cacheRoot ?? path.join(os.homedir(), ".ember", "remotes");
  return path.join(base, `${repo.owner}__${repo.repo}`);
}

export type SpawnGit = (args: string[], cwd?: string) => Promise<{ code: number; output: string }>;

export const realGit: SpawnGit = (args, cwd) => new Promise((resolve, reject) => {
  const p = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  let out = "";
  p.stdout.on("data", d => { out += d; });
  p.stderr.on("data", d => { out += d; });
  p.on("error", reject);
  p.on("close", code => resolve({ code: code ?? 1, output: out }));
});

/** Clone (or refresh) a repo into the cache. GIT_TERMINAL_PROMPT=0 makes an
 * auth-required (private/missing) repo FAIL instead of hanging on a prompt -
 * that failure is reported, never worked around with credentials. */
export async function cloneOrUpdate(repo: GitHubRepo, dest: string, log: (m: string) => void, git: SpawnGit = realGit): Promise<void> {
  const exists = await fs.stat(path.join(dest, ".git")).then(() => true, () => false);
  if (exists) {
    log(`cached clone of ${repo.label} found - fetching latest default branch`);
    const fetch = await git(["fetch", "--depth", "1", "origin", "HEAD"]);
    if (fetch.code === 0) {
      const reset = await git(["reset", "--hard", "FETCH_HEAD"], dest);
      if (reset.code === 0) return;
    }
    log("refresh failed - re-cloning from scratch");
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  log(`cloning ${repo.cloneUrl} (shallow, public repos only)...`);
  const r = await git(["clone", "--depth", "1", repo.cloneUrl, dest]);
  if (r.code !== 0) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    const tail = r.output.trim().split("\n").slice(-2).join(" ");
    throw new Error(`git clone failed: ${tail || "unknown error"} (private or missing repo? Ember loads public repos only)`);
  }
  const entries = await fs.readdir(dest);
  log(`clone complete: ${entries.length} top-level entries`);
}
