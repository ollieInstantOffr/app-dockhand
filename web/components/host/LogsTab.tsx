"use client";

import { useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/api";
import { clock } from "@/lib/format";
import { useShell } from "../shell/context";
import { LogRows, useLogStream, useStickToBottom, type LogMode } from "./logStream";

/** Dark panel chrome (kept for the legacy TerminalTab). */
export const DARK_PANEL: React.CSSProperties = {
  borderRadius: 22,
  background: "rgba(20,23,31,.92)",
  backdropFilter: "blur(24px) saturate(1.4)",
  WebkitBackdropFilter: "blur(24px) saturate(1.4)",
  border: "1px solid rgba(255,255,255,.08)",
  boxShadow: "0 24px 60px rgba(20,25,40,.25)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  minHeight: 560,
};

const MODES: { value: LogMode; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "tail", label: "Tail" },
  { value: "all", label: "All" },
];

export type LogStatus = "idle" | "connecting" | "live" | "ended" | "error";

/** Download the container's logs as a .log file (respects the 1h / Tail / All window). */
export async function downloadLogs(hostId: string, containerId: string, mode: LogMode, name: string) {
  const q = mode === "tail" ? "tail=5000" : mode === "1h" ? "since=1h&tail=all" : "tail=all";
  const res = await fetch(`/api/hosts/${hostId}/containers/${containerId}/logs?${q}&download=1`, { credentials: "same-origin" });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Live container log view for the floating terminal window: filter, 1h / Tail / All,
 * Live (pause) toggle and Download. Streams `/api/hosts/:id/containers/:cid/logs/ws`.
 */
export function LogsView({
  hostId,
  containerId,
  name,
  active,
  fontSize,
  onText,
  onStatus,
}: {
  hostId: string;
  containerId: string;
  name: string;
  active: boolean;
  fontSize: number;
  onText?: (get: (() => string) | null) => void;
  onStatus?: (s: LogStatus, lines: number, live: boolean) => void;
}) {
  const { toast } = useShell();
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<LogMode>("tail");
  const [live, setLive] = useState(true);
  const { lines, status } = useLogStream(hostId, containerId, mode, !live);
  const { ref, onScroll } = useStickToBottom(lines);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  useEffect(() => {
    onTextRef.current?.(() => {
      const q = filterRef.current.trim().toLowerCase();
      return linesRef.current
        .filter((l) => !q || l.line.toLowerCase().includes(q))
        .map((l) => `${clock(l.t)} ${l.level.padEnd(5)} ${l.line}`)
        .join("\n");
    });
    return () => onTextRef.current?.(null);
  }, []);

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    onStatusRef.current?.(status, lines.length, live);
  }, [status, lines.length, live]);

  const download = async () => {
    try {
      await downloadLogs(hostId, containerId, mode, name);
      toast({ kind: "ok", title: `Downloaded ${name} logs`, text: mode === "tail" ? "Last 5000 lines" : mode === "1h" ? "Last hour" : "Everything Docker kept" });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't download logs", text: errMsg(e) });
    }
  };

  const q = filter.trim().toLowerCase();
  const matchCount = q ? lines.filter((l) => l.line.toLowerCase().includes(q)).length : lines.length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: active ? "flex" : "none", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", flexWrap: "wrap", flex: "none" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs…"
          className="mono"
          style={{ height: 30, padding: "0 10px", borderRadius: 9, border: "1px solid rgba(255,255,255,.1)", background: "rgba(255,255,255,.05)", color: "#e6e9f0", fontSize: 12, width: 220, maxWidth: "100%" }}
        />
        <span style={{ display: "flex", gap: 2, padding: 2, borderRadius: 9, background: "rgba(255,255,255,.06)" }}>
          {MODES.map((m) => (
            <button
              key={m.value}
              className={m.value === mode ? undefined : "dk-seg"}
              onClick={() => setMode(m.value)}
              style={{ height: 24, padding: "0 9px", border: 0, borderRadius: 7, background: m.value === mode ? "rgba(255,255,255,.14)" : "transparent", color: m.value === mode ? "#fff" : "#aab1bf", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
            >
              {m.label}
            </button>
          ))}
        </span>
        {q && <span className="mono" style={{ fontSize: 11, color: "#6b7280" }}>{matchCount} match{matchCount === 1 ? "" : "es"}</span>}
        <button
          onClick={() => setLive(!live)}
          title={live ? "Pause the live stream" : "Resume the live stream"}
          style={{ marginLeft: "auto", height: 28, padding: "0 10px", borderRadius: 9, border: 0, background: live ? "rgba(60,207,122,.16)" : "rgba(255,255,255,.08)", color: live ? "#3ccf7a" : "#aab1bf", fontSize: 11.5, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", animation: live && status === "live" ? "blink 2s step-end infinite" : undefined }} />
          Live
        </button>
        <button className="dk-btn" onClick={download} style={{ height: 28, padding: "0 10px", borderRadius: 9, border: 0, background: "rgba(255,255,255,.08)", color: "#e6e9f0", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
          Download
        </button>
      </div>
      <div ref={ref} onScroll={onScroll} className="mono" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 18px 14px", fontSize, lineHeight: 1.65, color: "#d5d8de" }}>
        {lines.length === 0 && <Hint>{status === "connecting" ? "Connecting…" : status === "error" ? "Couldn't open the log stream." : status === "ended" ? "No log output." : "Waiting for log lines…"}</Hint>}
        <LogRows lines={lines} filter={filter} />
        {lines.length > 0 && status === "ended" && <Hint>— stream ended —</Hint>}
        {!live && <Hint>Paused — new lines are buffered until you turn Live back on.</Hint>}
      </div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "4px 8px", color: "#6b7280" }}>{children}</div>;
}
