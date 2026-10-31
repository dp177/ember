/** Recent repos for the live demo, kept truthful: every entry in the list
 * is a repo the visitor actually loaded successfully, persisted in the
 * browser's own localStorage (never sent anywhere). Pure functions over an
 * injected Storage-like surface so the logic is unit-testable in Node. */

export interface RecentRepo {
  /** "owner/repo" */
  label: string;
  /** Branch or tag that was loaded (the resolved default branch counts). */
  branch: string;
  chunkCount: number;
  fileCount: number;
  /** ISO time of the last successful load. */
  loadedAt: string;
}

/** Minimal Storage surface (satisfied by window.localStorage). */
export interface RecentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RECENT_REPOS_KEY = "ember-demo-recent-repos";
export const MAX_RECENT_REPOS = 5;

/** Read the list, tolerating missing/corrupt storage (private mode,
 * cleared data, hand-edited JSON all degrade to an empty list). */
export function loadRecents(store: RecentStore): RecentRepo[] {
  try {
    const raw = store.getItem(RECENT_REPOS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRepo =>
        !!r && typeof r === "object" &&
        // "@" never appears in owner/repo names - its presence means an
        // old display-flavored "owner/repo@ref" label; drop those entries.
        typeof r.label === "string" && r.label.includes("/") && !r.label.includes("@") &&
        typeof r.branch === "string" && r.branch.length > 0 &&
        typeof r.chunkCount === "number" && typeof r.fileCount === "number" &&
        typeof r.loadedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Record a successful load: dedupes by label+branch (newest wins), keeps
 * most-recent-first order, caps the list at MAX_RECENT_REPOS. */
export function recordRecent(store: RecentStore, entry: RecentRepo, now: string = entry.loadedAt): RecentRepo[] {
  const next = [
    { ...entry, loadedAt: now },
    ...loadRecents(store).filter(r => !(r.label === entry.label && r.branch === entry.branch)),
  ].slice(0, MAX_RECENT_REPOS);
  try {
    store.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode); recents are a convenience,
    // never a requirement - the load itself already succeeded.
  }
  return next;
}

/** The GitHub URL that reloads a recent entry through the normal loader
 * (the /tree/<branch> form is honored by parseGitHubUrl). */
export function recentRepoUrl(r: RecentRepo): string {
  return `https://github.com/${r.label}/tree/${r.branch}`;
}
