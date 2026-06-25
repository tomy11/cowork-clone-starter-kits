import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const outputDirectory = path.join(root, "sidecar-dist");
const binaryDirectory = path.join(root, "src-tauri", "binaries");
mkdirSync(outputDirectory, { recursive: true });
mkdirSync(binaryDirectory, { recursive: true });

const esbuildScript = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
const bundledEntry = path.join(outputDirectory, "index.cjs");
execFileSync(esbuildScript, [
  "core/index.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node20",
  "--external:better-sqlite3",
  `--outfile=${bundledEntry}`,
], { cwd: root, stdio: "inherit" });

let targetTriple;
try {
  targetTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf-8" }).trim();
} catch {
  const version = execFileSync("rustc", ["-Vv"], { encoding: "utf-8" });
  targetTriple = version.match(/^host:\s*(.+)$/m)?.[1]?.trim();
}
if (!targetTriple) throw new Error("Unable to determine Rust host target triple");

const extension = process.platform === "win32" ? ".exe" : "";
const binaryPath = path.join(binaryDirectory, `cowork-sidecar-${targetTriple}${extension}`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, [
  "--no-install",
  "pkg",
  bundledEntry,
  "--config",
  path.join(root, "package.json"),
  "--targets",
  "host",
  "--output",
  binaryPath,
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PKG_CACHE_PATH: path.join(outputDirectory, ".pkg-cache") },
});

console.log(`Sidecar packaged: ${binaryPath}`);
