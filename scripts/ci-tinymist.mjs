// CI only: exercise native-server tests against the current stable upstream release.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
const platform = { win32: "pc-windows-msvc.zip", darwin: "apple-darwin.tar.gz", linux: "unknown-linux-gnu.tar.gz" }[process.platform];
if (!arch || !platform || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
  throw new Error("Expected a supported GitHub runner");
}
const headers = { "User-Agent": "typst-live-native-ci" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
async function get(url, api = false) {
  const response = await fetch(url, { headers: api ? headers : {}, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Upstream release request returned ${response.status}`);
  return response;
}
const release = await (await get("https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest", true)).json();
if (release.draft || release.prerelease) throw new Error("Expected a stable Tinymist release");
const name = `tinymist-${arch}-${platform}`;
const asset = release.assets.find((item) => item.name === name);
const checksum = release.assets.find((item) => item.name === name + ".sha256");
if (!asset || (!asset.digest && !checksum)) throw new Error("Upstream release has no verifiable native artifact");
const bytes = Buffer.from(await (await get(asset.browser_download_url)).arrayBuffer());
const expected = asset.digest?.replace(/^sha256:/, "") ??
  (await (await get(checksum.browser_download_url)).text()).trim().split(/\s+/)[0];
if (!/^[0-9a-f]{64}$/i.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()) {
  throw new Error("Tinymist release checksum differs");
}
const destination = join(process.env.RUNNER_TEMP, "typst-live-native-tinymist");
mkdirSync(destination, { recursive: true });
const archive = join(process.env.RUNNER_TEMP, name);
writeFileSync(archive, bytes);
const result = spawnSync("tar", ["-xf", archive, "-C", destination], { stdio: "inherit" });
if (result.status !== 0) throw new Error("Native Tinymist extraction failed");
const executable = process.platform === "win32" ? "tinymist.exe" : "tinymist";
function find(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isFile() && entry.name === executable) return file;
    if (entry.isDirectory()) { const nested = find(file); if (nested) return nested; }
  }
}
const binary = find(destination);
if (!binary || spawnSync(binary, ["--version"], { stdio: "inherit" }).status !== 0) {
  throw new Error("Native Tinymist did not start");
}
appendFileSync(process.env.GITHUB_ENV, `TINYMIST_BIN=${binary}\n`);
