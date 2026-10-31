import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { EMBER_VERSION } from "../src/core/version.js";
import { EMBER_VERSION as MCP_VERSION } from "../src/mcp/server.js";

const pkg = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

test("package.json, CLI --version and MCP server report the same version", () => {
  const cli = execFileSync(process.execPath, ["dist/cli.js", "--version"], { encoding: "utf8" }).trim();
  assert.equal(cli, pkg, `CLI --version (${cli}) must equal package.json (${pkg})`);
  assert.equal(EMBER_VERSION, pkg, `shared version (${EMBER_VERSION}) must equal package.json (${pkg})`);
  assert.equal(MCP_VERSION, pkg, `MCP server version (${MCP_VERSION}) must equal package.json (${pkg})`);
});
