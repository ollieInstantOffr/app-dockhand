"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * One interactive terminal session (host SSH shell or container exec).
 * Protocol: binary frames = PTY output; text frames {"type":"input"|"resize"} to the
 * server; {"type":"exit"} from the server ends the session.
 */
export function XTerm({ path, active, fontSize = 13, onDims, onState, onReady }: { path: string; active: boolean; fontSize?: number; onDims?: (d: { cols: number; rows: number }) => void; onState?: (s: "connecting" | "open" | "ended") => void; onReady?: (t: Terminal | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [gen, setGen] = useState(0);
  const [ended, setEnded] = useState(false);
  const onDimsRef = useRef(onDims);
  onDimsRef.current = onDims;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    let term: Terminal | null = null;
    setEnded(false);
    onStateRef.current?.("connecting");

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: fontRef.current,
        lineHeight: 1.3,
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 5000,
        theme: {
          background: "rgba(0,0,0,0)",
          foreground: "#d5d8de",
          cursor: "#d5d8de",
          cursorAccent: "#14171f",
          selectionBackground: "rgba(125,196,255,.28)",
          black: "#14171f",
          red: "#ff8a85",
          green: "#9fd18b",
          yellow: "#f2c05c",
          blue: "#7dc4ff",
          magenta: "#c7a6ff",
          cyan: "#6fd6d9",
          white: "#d5d8de",
          brightBlack: "#6b7280",
          brightRed: "#ffa8a4",
          brightGreen: "#b8e3a6",
          brightYellow: "#f7d38a",
          brightBlue: "#a3d5ff",
          brightMagenta: "#dac4ff",
          brightCyan: "#9be6e8",
          brightWhite: "#ffffff",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      termRef.current = term;
      fitRef.current = fit;
      onReadyRef.current?.(term);
      const doFit = () => {
        if (!el.offsetWidth || !el.offsetHeight) return;
        try {
          fit.fit();
        } catch {
          /* not visible yet */
        }
      };
      doFit();
      try {
        await document.fonts?.ready;
      } catch {
        /* ignore */
      }
      if (disposed) return;
      doFit();
      onDimsRef.current?.({ cols: term.cols, rows: term.rows });

      const sep = path.includes("?") ? "&" : "?";
      ws = new WebSocket(wsUrl(`${path}${sep}cols=${term.cols}&rows=${term.rows}`));
      ws.binaryType = "arraybuffer";
      const t = term;
      let exited = false;
      const end = (msg: string) => {
        if (exited) return;
        exited = true;
        t.write(`\r\n\x1b[90m${msg}\x1b[0m\r\n`);
        setEnded(true);
        onStateRef.current?.("ended");
      };
      ws.onopen = () => {
        onStateRef.current?.("open");
        if (active) t.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type === "exit") {
              end(`[session ended${typeof m.code === "number" && m.code !== 0 ? ` · exit ${m.code}` : ""}]`);
              return;
            }
            if (m && m.type === "error") {
              t.write(`\r\n\x1b[31m${m.error ?? m.message ?? "error"}\x1b[0m\r\n`);
              return;
            }
          } catch {
            /* plain text output */
          }
          t.write(ev.data);
        } else {
          t.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
      ws.onerror = () => {
        t.write("\r\n\x1b[31mCouldn't open the terminal connection.\x1b[0m");
      };
      ws.onclose = () => {
        if (!disposed) end("[session ended]");
      };
      t.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
      });
      t.onResize(({ cols, rows }) => {
        onDimsRef.current?.({ cols, rows });
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      ro = new ResizeObserver(() => doFit());
      ro.observe(el);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      term?.dispose();
      onReadyRef.current?.(null);
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, gen]);

  // Live font size changes (terminal window − / +).
  useEffect(() => {
    const t = termRef.current;
    if (!t || t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    const el = hostRef.current;
    if (el && el.offsetWidth && el.offsetHeight && fitRef.current) {
      try {
        fitRef.current.fit();
      } catch {
        /* ignore */
      }
    }
  }, [fontSize]);

  // Re-fit and focus when this session becomes visible.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      const el = hostRef.current;
      if (el && el.offsetWidth && fitRef.current) {
        try {
          fitRef.current.fit();
        } catch {
          /* ignore */
        }
      }
      const t = termRef.current;
      if (t) {
        onDimsRef.current?.({ cols: t.cols, rows: t.rows });
        t.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div style={{ position: "relative", flex: 1, display: active ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
      <div ref={hostRef} className="xterm-host" style={{ minHeight: 0 }} />
      {ended && (
        <div style={{ position: "absolute", right: 16, bottom: 16, display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 14px", borderRadius: 12, background: "rgba(36,41,54,.95)", border: "1px solid rgba(255,255,255,.1)", boxShadow: "0 12px 30px rgba(0,0,0,.35)", fontFamily: "var(--font)" }}>
          <span style={{ fontSize: 12.5, color: "#aab1bf" }}>Session ended</span>
          <button onClick={() => setGen((g) => g + 1)} style={{ height: 30, padding: "0 12px", borderRadius: 9, border: 0, background: "#eef0f5", color: "#171a21", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
