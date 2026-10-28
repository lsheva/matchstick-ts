/**
 * Typecheck the AssemblyScript sources (`assembly/`, `templates/`) with tsc
 * and AssemblyScript's std types. graph-ts and matchstick-as ship `.ts`
 * sources that tsc rejects in a few places (namespace/function merging),
 * and `skipLibCheck` only skips `.d.ts`, so errors inside node_modules are
 * dropped here.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "assembly/tsconfig.json", "--pretty", "false"], {
  encoding: "utf8",
});

const errors = result.stdout
  .split("\n")
  .filter((line) => /error TS\d+/.test(line) && !line.includes("node_modules"));

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
