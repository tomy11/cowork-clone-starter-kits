import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm-slim";
export const DEFAULT_SANDBOX_TARGET = "/workspace";

export type DockerSandboxOptions = {
  workspace: string;
  command: string[];
  image?: string;
  network?: string;
  target?: string;
  workdir?: string;
  write?: boolean;
  env?: string[];
  timeoutMs?: number;
  maxBuffer?: number;
};

export type DockerSandboxResult = {
  stdout: string;
  stderr: string;
  command: string;
};

export function buildDockerSandboxArgs(options: DockerSandboxOptions) {
  const workspace = realpathSync(options.workspace);
  if (!statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }

  const target = options.target ?? DEFAULT_SANDBOX_TARGET;
  const mount = [
    "type=bind",
    `source=${workspace}`,
    `target=${target}`,
    options.write ? "" : "readonly",
  ].filter(Boolean).join(",");

  const args = [
    "run",
    "--rm",
    "--network",
    options.network ?? "none",
    "--workdir",
    options.workdir ?? target,
    "--mount",
    mount,
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--env",
    "HOME=/tmp",
  ];

  if (!options.write) args.push("--read-only");
  for (const entry of options.env ?? []) args.push("--env", entry);
  args.push(options.image ?? DEFAULT_SANDBOX_IMAGE, ...options.command);
  return args;
}

export function formatSandboxCommand(binary: string, args: string[]) {
  return [binary, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:=,@+-]+$/.test(part)) return part;
    return `'${part.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

export function runDockerSandbox(options: DockerSandboxOptions): Promise<DockerSandboxResult> {
  const dockerArgs = buildDockerSandboxArgs(options);
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      dockerArgs,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        const command = formatSandboxCommand("docker", dockerArgs);
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("Docker sandbox is unavailable: docker executable was not found"));
            return;
          }
          if (error.killed) {
            reject(new Error(`Sandbox command timed out after ${(options.timeoutMs ?? 0) / 1000}s`));
            return;
          }
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          reject(new Error(`Sandbox command failed (exit ${error.code ?? "?"}): ${output || error.message}`));
          return;
        }
        resolve({ stdout, stderr, command });
      },
    );
  });
}
