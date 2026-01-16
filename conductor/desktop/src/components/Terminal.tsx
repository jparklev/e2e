import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

type Props = {
  workspacePath: string;
  sessionId: string;
};

export function Terminal({ workspacePath, sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [shellId, setShellId] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal instance
    const terminal = new XTerm({
      fontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#6a9955",
        brightYellow: "#dcdcaa",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Spawn shell process
    const spawnShell = async () => {
      try {
        const id = await invoke<string>("spawn_shell", {
          cwd: workspacePath,
          sessionId,
        });
        setShellId(id);
        terminal.writeln(`\x1b[90m# Shell started in ${workspacePath}\x1b[0m`);
        terminal.writeln("");
      } catch (err) {
        terminal.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
      }
    };
    spawnShell();

    // Handle terminal input
    terminal.onData((data) => {
      if (shellId) {
        invoke("write_shell", { shellId, data }).catch(console.error);
      }
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (shellId) {
        invoke("resize_shell", {
          shellId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(console.error);
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      terminal.dispose();
      if (shellId) {
        invoke("kill_shell", { shellId }).catch(console.error);
      }
    };
  }, [workspacePath, sessionId]);

  // Listen for shell output
  useEffect(() => {
    if (!shellId) return;

    let unlisten: UnlistenFn | null = null;

    const setup = async () => {
      unlisten = await listen<{ shell_id: string; data: string }>(
        "shell_output",
        (event) => {
          if (event.payload.shell_id === shellId && terminalRef.current) {
            terminalRef.current.write(event.payload.data);
          }
        }
      );
    };
    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, [shellId]);

  // Update shell ID when it becomes available
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !shellId) return;

    // Re-bind onData with the new shellId
    const disposable = terminal.onData((data) => {
      invoke("write_shell", { shellId, data }).catch(console.error);
    });

    return () => disposable.dispose();
  }, [shellId]);

  // Handle container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="terminal-container" />;
}
