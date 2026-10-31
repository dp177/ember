// Child-process lock holder for cross-process store tests.
// usage: node lock-holder.mjs <repoDir> <hold|hold-old|crash>
import { promises as fs } from "node:fs";
const [dir, mode] = process.argv.slice(2);
const at = mode === "hold-old" ? Date.now() - 2 * 60 * 60 * 1000 : Date.now();
await fs.writeFile(`${dir}/.ember.lock`, JSON.stringify({ pid: process.pid, at, token: "child" }));
if (mode === "crash") {
  // Die mid-swap: live set moved aside, staged set never swapped in, lock held.
  await fs.rename(`${dir}/.ember`, `${dir}/.ember.backup-${process.pid}`);
  process.exit(1);
}
if (mode === "hold" || mode === "hold-old") setTimeout(() => {}, 30000);
// mode "exit": fall through and exit, leaving a dead-pid lock behind
