/** Recognized source file extensions and per-file size cap - shared by
 * the scanner (Node) and the browser demo's repo loader (pure module). */
export const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".cpp": "cpp", ".cc": "cpp",
  ".cxx": "cpp", ".c": "c", ".h": "c-header", ".hpp": "cpp-header", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".swift": "swift", ".scala": "scala",
  ".md": "markdown", ".mdx": "markdown", ".sql": "sql", ".sh": "shell",
  ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".toml": "toml",
};

export const MAX_FILE_BYTES = 256 * 1024;

export const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "Gemfile.lock", "poetry.lock", "Cargo.lock", "go.sum",
]);
