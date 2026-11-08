import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Load a new kit boundary without making the test bundle depend on it before it exists. */
export function loadKitModule<T>(relativePath: string): T {
  const { buildSync } = createRequire(join(process.cwd(), "package.json"))("esbuild") as typeof import("esbuild");
  const directory = mkdtempSync(join(tmpdir(), "tinymist-kit-test-"));
  const outfile = join(directory, "boundary.cjs");
  try {
    buildSync({
      entryPoints: [resolve(relativePath)],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      logLevel: "silent",
    });
    return require(outfile) as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
