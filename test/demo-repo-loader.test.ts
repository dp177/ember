/** Browser repo loader: hermetic tests over the pure selection logic and
 * the tree-fetch error mapping. No network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFiles, fetchRepoTree, DEMO_MAX_FILES, DEMO_MAX_BYTES, type TreeEntry, type FetchText } from "../demo-web/repo-loader.js";
import { parseGitHubUrl } from "../src/ui/github-url.js";

const blob = (path: string, size = 100): TreeEntry => ({ path, type: "blob", size });

test("selectFiles keeps recognized source files, skips junk, and reports why", () => {
  const entries: TreeEntry[] = [
    blob("src/index.ts", 500),
    blob("README.md", 900),
    blob("docs/logo.png", 4000),          // unsupported extension
    blob("package-lock.json", 90000),     // lockfile
    blob("node_modules/x/index.js", 100), // dependency dir
    blob("big.ts", 300_000),              // over 256 KB
    blob("empty.js", 0),                  // empty
    { path: "src", type: "tree" },        // not a blob
    blob("dist/bundle.js", 200),          // build dir
  ];
  const { files, skipped, bounded } = selectFiles(entries);
  assert.deepEqual(files.map(f => f.path).sort(), ["README.md", "src/index.ts"]);
  assert.equal(bounded, false);
  const reasons = new Map(skipped.map(s => [s.reason, s.count]));
  assert.equal(reasons.get("unsupported extension"), 1);
  assert.equal(reasons.get("lockfile/minified"), 1);
  assert.equal(reasons.get("dependency/build dir"), 2); // node_modules + dist
  assert.equal(reasons.get("over 256 KB"), 1);
  assert.equal(reasons.get("empty"), 1);
});

test("selectFiles enforces the demo caps deterministically (smallest first)", () => {
  const entries: TreeEntry[] = [];
  for (let i = 0; i < 10; i++) entries.push(blob(`f${i}.ts`, 100_000)); // 1 MB total
  const { files, bounded, skipped } = selectFiles(entries, 5, 450_000);
  assert.equal(files.length, 4, "byte cap binds before file cap");
  assert.equal(bounded, true);
  assert.ok(skipped.some(s => s.reason.includes("over demo cap") && s.count === 6));
  // Deterministic: same input, same output
  const again = selectFiles(entries, 5, 450_000);
  assert.deepEqual(again.files, files);
  assert.ok(DEMO_MAX_FILES > 0 && DEMO_MAX_BYTES > 0, "caps are real constants");
});

const repo = parseGitHubUrl("github.com/octocat/Hello-World");

test("fetchRepoTree maps 404 to a public-only message, never a credential ask", async () => {
  const notFound: FetchText = async () => ({ ok: false, status: 404, body: "" });
  await assert.rejects(fetchRepoTree(repo, notFound), /missing or private.*public repos only, no login/);
});

test("fetchRepoTree surfaces GitHub's anonymous rate limit with its reset time", async () => {
  const limited: FetchText = async () => ({ ok: false, status: 403, body: "", rateLimitReset: 2000000000 });
  await assert.rejects(fetchRepoTree(repo, limited), /rate limit is exhausted - try again after/);
});

test("fetchRepoTree honors a /tree/<branch> ref instead of the default branch", async () => {
  const seen: string[] = [];
  const ok: FetchText = async (url) => {
    seen.push(url);
    if (url.includes("/git/trees/")) return { ok: true, status: 200, body: JSON.stringify({ tree: [], truncated: false }) };
    return { ok: true, status: 200, body: JSON.stringify({ default_branch: "main" }) };
  };
  const t = await fetchRepoTree(parseGitHubUrl("github.com/octocat/Hello-World/tree/xyz"), ok);
  assert.equal(t.defaultBranch, "xyz", "the URL's branch wins, no default-branch substitution");
  assert.ok(seen[1].includes("/git/trees/xyz"));
});
