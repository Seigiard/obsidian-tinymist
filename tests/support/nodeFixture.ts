import type { SpawnOptions } from "node:child_process";
const childProcess = require("node:child_process") as typeof import("node:child_process");

/** Execute a synthetic JS server through Node on every OS, without a shell. */
export function nodeFixture(binary: string): () => Promise<void> {
  const original = childProcess.spawn;
  const children: import("node:child_process").ChildProcess[] = [];
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = ((command: string, args: string[], options: SpawnOptions) => {
    if (command !== binary) return original(command, args, options);
    const child = original(process.execPath, [binary, ...args], options);
    children.push(child);
    return child;
  }) as typeof childProcess.spawn;
  return async () => {
    (childProcess as { spawn: typeof childProcess.spawn }).spawn = original;
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) =>
      new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill(); })));
  };
}
