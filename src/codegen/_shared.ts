/**
 * Shared codegen utilities.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a file only if its contents differ from what's already on disk.
 * Returns `true` when the file was written, `false` when unchanged.
 *
 * Used so repeated codegen calls (e.g., one per `runMatchstickTest`) don't
 * touch mtimes — matchstick's AS WASM cache and tsserver's file watchers
 * stay calm.
 */
export async function writeIfChanged(path: string, contents: string): Promise<boolean> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // file doesn't exist; treat as different
  }
  if (existing === contents) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return true;
}
