import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";

type TerminalCommandOutput = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
};

type Props = {
  folder: string | null;
  onClose: () => void;
};

const quickCommands = ["pwd", "git status --short", "ls", "npm test"];

export function TerminalDock({ folder, onClose }: Props) {
  const [command, setCommand] = useState("git status --short");
  const [history, setHistory] = useState<TerminalCommandOutput[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runCommand(nextCommand = command) {
    const trimmed = nextCommand.trim();
    if (!folder || !trimmed || running) return;
    setRunning(true);
    setError(null);
    setCommand(trimmed);
    try {
      const result = await invoke<TerminalCommandOutput>("run_terminal_command", {
        workspace: folder,
        command: trimmed,
      });
      setHistory((current) => [result, ...current].slice(0, 20));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  return (
    <section className="terminal-dock" aria-label="Terminal dock">
      <header className="terminal-header">
        <div>
          <strong>Terminal</strong>
          <span>{folder ? shortPath(folder) : "No workspace selected"}</span>
        </div>
        <button type="button" aria-label="Close terminal" onClick={onClose}><Icon name="x" size={15} /></button>
      </header>

      <form
        className="terminal-command"
        onSubmit={(event) => {
          event.preventDefault();
          void runCommand();
        }}
      >
        <span>$</span>
        <input
          ref={inputRef}
          value={command}
          disabled={!folder || running}
          onChange={(event) => setCommand(event.target.value)}
        />
        <button type="submit" disabled={!folder || running || !command.trim()}>
          {running ? "Running" : "Run"}
        </button>
      </form>

      <div className="terminal-quick" aria-label="Quick commands">
        {quickCommands.map((item) => (
          <button type="button" key={item} disabled={!folder || running} onClick={() => void runCommand(item)}>
            {item}
          </button>
        ))}
      </div>

      {error && <p className="terminal-error">{error}</p>}

      <div className="terminal-output">
        {history.length === 0 ? (
          <p>No commands run yet</p>
        ) : (
          history.map((entry, index) => (
            <article key={`${entry.command}-${index}`}>
              <div>
                <strong>$ {entry.command}</strong>
                <span>exit {entry.code ?? "signal"} · {entry.durationMs}ms</span>
              </div>
              {entry.stdout && <pre>{entry.stdout}</pre>}
              {entry.stderr && <pre className="terminal-stderr">{entry.stderr}</pre>}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function shortPath(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/");
}
