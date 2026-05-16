#!/usr/bin/env node
/**
 * CLI for the codegen step. Two subcommands:
 *   subgraph-snapshot generate-runner   <subgraph.yaml>   <out.test.ts>
 *   subgraph-snapshot generate-entities <schema.graphql>  <out.ts>
 */
import { generateRunner, generateEntities } from "../codegen/index.ts";

const USAGE = `Usage:
  subgraph-snapshot generate-runner   <subgraph.yaml>  <output.test.ts>  [--assembly <import-specifier>] [--temp-dir <path>]
  subgraph-snapshot generate-entities <schema.graphql> <output.d.ts>     [--module-specifier <name>]

Note: When using \`runMatchstickTest\` with \`autoCodegen: true\` (the default),
neither subcommand is required — codegen runs in-process on each test call.
This CLI is retained for explicit / CI-driven workflows.

Options:
  --assembly           AS import specifier for the runner template (default: subgraph-snapshot/assembly)
  --temp-dir           Directory the runner reads JSON IO from (default: tests/.tmp)
                       Must match RunOptions.jsonDir on the TS side.
  --module-specifier   Module name to augment (default: subgraph-snapshot).
                       Set this if you've installed the package under a different name.
`;

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) die(`Missing value for ${name}`);
  args.splice(i, 2);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();

  switch (cmd) {
    case "generate-runner": {
      const assemblyImport = flag(argv, "--assembly");
      const tempDir = flag(argv, "--temp-dir");
      const [subgraphYamlPath, outputPath] = argv;
      if (!subgraphYamlPath || !outputPath) die(USAGE);
      await generateRunner({ subgraphYamlPath, outputPath, assemblyImport, tempDir });
      return;
    }
    case "generate-entities": {
      const moduleSpecifier = flag(argv, "--module-specifier");
      const [schemaPath, outputPath] = argv;
      if (!schemaPath || !outputPath) die(USAGE);
      await generateEntities({ schemaPath, outputPath, moduleSpecifier });
      return;
    }
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return;
    default:
      die(`Unknown subcommand: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
