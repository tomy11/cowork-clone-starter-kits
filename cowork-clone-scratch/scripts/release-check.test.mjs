import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReleaseChecks } from "./release-check.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release-check", () => {
  it("passes for the repository release configuration", () => {
    expect(runReleaseChecks(process.cwd())).toEqual([]);
  });

  it("reports version drift between package and Tauri config", async () => {
    const fixture = await copyMinimalReleaseFixture();
    const tauriPath = path.join(fixture, "src-tauri", "tauri.conf.json");
    const tauriConfig = JSON.parse(await readFile(tauriPath, "utf-8"));
    tauriConfig.version = "9.9.9";
    await writeFile(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, "utf-8");

    expect(runReleaseChecks(fixture)).toContain("Version mismatch: package.json=0.1.0, tauri.conf.json=9.9.9");
  });
});

async function copyMinimalReleaseFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-release-check-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src-tauri"), { recursive: true });
  await mkdir(path.join(root, "..", ".github", "workflows"), { recursive: true });

  for (const filePath of ["package.json", "RELEASE.md", "SANDBOX.md", "SECURITY.md", "SERVER.md"]) {
    await writeFile(path.join(root, filePath), await readFile(path.join(process.cwd(), filePath), "utf-8"), "utf-8");
  }
  await writeFile(
    path.join(root, "src-tauri", "tauri.conf.json"),
    await readFile(path.join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf-8"),
    "utf-8",
  );
  for (const workflow of ["ci.yml", "release-build.yml"]) {
    await writeFile(
      path.join(root, "..", ".github", "workflows", workflow),
      await readFile(path.join(process.cwd(), "..", ".github", "workflows", workflow), "utf-8"),
      "utf-8",
    );
  }
  return root;
}
