// Hermetic tests for the demo's recent-repos list: an in-memory fake
// Storage stands in for window.localStorage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecents, recordRecent, recentRepoUrl, RECENT_REPOS_KEY, MAX_RECENT_REPOS, type RecentRepo } from "../demo-web/recent-repos.js";

function fakeStore(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(RECENT_REPOS_KEY, initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const entry = (label: string, branch = "main", loadedAt = "2026-11-01T00:00:00.000Z"): RecentRepo =>
  ({ label, branch, chunkCount: 33, fileCount: 7, loadedAt });

test("empty, missing and corrupt storage all read as an empty list", () => {
  assert.deepEqual(loadRecents(fakeStore()), []);
  assert.deepEqual(loadRecents(fakeStore("not json")), []);
  assert.deepEqual(loadRecents(fakeStore('{"nope":1}')), []);
  assert.deepEqual(loadRecents(fakeStore('[{"label":"x"}]')), []); // malformed entries dropped
});

test("recordRecent persists and reads back most-recent-first", () => {
  const s = fakeStore();
  recordRecent(s, entry("a/one"));
  recordRecent(s, entry("b/two"));
  const list = loadRecents(s);
  assert.deepEqual(list.map(r => r.label), ["b/two", "a/one"]);
});

test("reloading the same repo+branch dedupes and moves it to the front", () => {
  const s = fakeStore();
  recordRecent(s, entry("a/one"));
  recordRecent(s, entry("b/two"));
  recordRecent(s, { ...entry("a/one"), chunkCount: 40 }, "2026-11-01T01:00:00.000Z");
  const list = loadRecents(s);
  assert.deepEqual(list.map(r => r.label), ["a/one", "b/two"]);
  assert.equal(list[0].chunkCount, 40);
});

test("the same repo on a different branch is a separate entry", () => {
  const s = fakeStore();
  recordRecent(s, entry("a/one", "main"));
  recordRecent(s, entry("a/one", "dev"));
  assert.equal(loadRecents(s).length, 2);
});

test("the list is capped at MAX_RECENT_REPOS, dropping the oldest", () => {
  const s = fakeStore();
  for (let i = 0; i < MAX_RECENT_REPOS + 2; i++) recordRecent(s, entry(`o/r${i}`));
  const list = loadRecents(s);
  assert.equal(list.length, MAX_RECENT_REPOS);
  assert.equal(list[0].label, `o/r${MAX_RECENT_REPOS + 1}`);
  assert.equal(list.at(-1)!.label, "o/r2");
});

test("a store that throws on write still returns the list (load already succeeded)", () => {
  const s = { getItem: () => null, setItem: () => { throw new Error("denied"); } };
  const list = recordRecent(s, entry("a/one"));
  assert.deepEqual(list.map(r => r.label), ["a/one"]);
});

test("recentRepoUrl round-trips through the /tree/<branch> form", () => {
  assert.equal(recentRepoUrl(entry("sindresorhus/parse-json", "main")),
    "https://github.com/sindresorhus/parse-json/tree/main");
});

test("display-flavored labels containing @ (older builds) are dropped", () => {
  const s = fakeStore(JSON.stringify([
    { label: "a/one@main", branch: "main", chunkCount: 1, fileCount: 1, loadedAt: "2026-11-01T00:00:00.000Z" },
    { label: "a/one", branch: "main", chunkCount: 1, fileCount: 1, loadedAt: "2026-11-01T00:00:00.000Z" },
  ]));
  assert.deepEqual(loadRecents(s).map(r => r.label), ["a/one"]);
});
