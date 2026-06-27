#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { cwd, exit, argv } from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_TARGET = "/workspace";

export function parseSandboxArgs(rawArgs) {
  const options = {
    dryRun: false,
    env: [],
    image: DEFAULT_IMAGE,
    network: "none",
    target: DEFAULT_TARGET,
    workspace: cwd(),
    write: false,
  };
  const commandIndex = rawArgs.indexOf("--");
  if (commandIndex === -1) {
    throw new Error("Command is required after --");
  }
  const optionArgs = commandIndex === -1 ? rawArgs : rawArgs.slice(0, commandIndex);
  const command = commandIndex === -1 ? [] : rawArgs.slice(commandIndex + 1);

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--workspace") {
      options.workspace = requiredValue(optionArgs, ++index, arg);
    } else if (arg === "--image") {
      options.image = requiredValue(optionArgs, ++index, arg);
    } else if (arg === "--network") {
      options.network = requiredValue(optionArgs, ++index, arg);
    } else if (arg === "--target") {
      options.target = requiredValue(optionArgs, ++index, arg);
    } else if (arg === "--env") {
      options.env.push(requiredValue(optionArgs, ++index, arg));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (command.length === 0) {
    throw new Error("Command is required after --");
  }

  return { options, command };
}

export function buildDockerArgs(options, command) {
  const workspace = realpathSync(options.workspace);
  if (!statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  const mount = [
    "type=bind",
    `source=${workspace}`,
    `target=${options.target}`,
    options.write ? "" : "readonly",
  ].filter(Boolean).join(",");

  const args = [
    "run",
    "--rm",
    "--network",
    options.network,
    "--workdir",
    options.target,
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
  for (const entry of options.env) args.push("--env", entry);
  args.push(options.image, ...command);
  return args;
}

export function formatShellCommand(binary, args) {
  return [binary, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:=,@+-]+$/.test(part)) return part;
    return `'${part.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function main() {
  try {
    const { options, command } = parseSandboxArgs(argv.slice(2));
    const dockerArgs = buildDockerArgs(options, command);
    if (options.dryRun) {
      console.log(formatShellCommand("docker", dockerArgs));
      return;
    }
    const child = spawn("docker", dockerArgs, { stdio: "inherit" });
    child.on("exit", (code) => exit(code ?? 1));
    child.on("error", (error) => {
      console.error(`Failed to run Docker sandbox: ${error.message}`);
      exit(1);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
