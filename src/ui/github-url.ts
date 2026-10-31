/** Pure GitHub repo URL parser - the security boundary for repo loading.
 * No Node imports: this module also runs in the browser demo.
 * Accepted: github.com/owner/repo, https://github.com/owner/repo[.git][/],
 * and /tree/<branch-or-tag> (honored by callers: that ref is cloned or
 * fetched, never silently swapped for the default branch). */
export interface GitHubRepo { owner: string; repo: string; ref?: string; cloneUrl: string; label: string; }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Branch/tag names: no spaces, no "..", no control chars; single path
// segment only (a /tree/a/b link is ambiguous - GitHub resolves it
// greedily - so we refuse rather than guess).
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

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
