// Build the sibling `matchstick-ts` package (since `link:../matchstick-ts`
// only symlinks the folder — it does not install or build its contents),
// then build this package.
//
// Runs in two contexts:
//   1. Local monorepo dev: `pnpm install` at the workspace root triggers
//      `prepare` on every workspace package. The sibling has already been
//      installed and (likely) built by its own `prepare`. Re-running tsc
//      here is idempotent and cheap.
//   2. Consumer git install (`github:lsheva/matchstick-ts#main&path:packages/hardhat-matchstick-ts`):
//      pnpm clones the whole repo into a temp dir and runs `pnpm install` +
//      `prepare` in this subdirectory only. The sibling exists on disk but
//      its `node_modules/` and `dist/` do not — so we install + build it
//      here before linking against it.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = resolve(here, "..");
const sibling = resolve(self, "../matchstick-ts");

function run(cmd, cwd) {
  console.log(`$ (cd ${cwd}) ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

if (!existsSync(resolve(sibling, "node_modules"))) {
  run("pnpm install --prod=false --ignore-scripts --config.confirmModulesPurge=false", sibling);
}
run("pnpm run build", sibling);
run("pnpm run build", self);
