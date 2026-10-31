/** Single source of truth for Ember's version: the nearest enclosing package.json named "ember-mcp". */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function findVersion(): string {
  const req = createRequire(import.meta.url);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = req(path.join(dir, "package.json")) as { name?: string; version?: string };
      if (pkg.name === "ember-mcp" && typeof pkg.version === "string") return pkg.version;
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  return "0.0.0-unknown";
}

export const EMBER_VERSION = findVersion();
