"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { wsUrl } from "@/lib/api";
import { clock } from "@/lib/format";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

export interface LogLine {
  id: number;
  t: string;
  stream: "stdout" | "stderr";
  line: string;
  level: LogLevel;
}

export type LogMode = "1h" | "tail" | "all";

export const LEVEL_COLOR: Record<LogLevel, string> = {
  ERROR: "#ff8a85",
  WARN: "#f2c05c",
  INFO: "#7dc4ff",
  DEBUG: "#6b7280",
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RE_ERR = /\b(ERROR|ERR|FATAL|CRIT|CRITICAL|PANIC|EMERG|ALERT)\b|\blevel=(error|fatal|panic)\b|"level":\s*"(error|fatal|panic)"/i;
const RE_WARN = /\b(WARN|WARNING)\b|\blevel=warn(ing)?\b|"level":\s*"warn(ing)?"/i;
const RE_DEBUG = /\b(DEBUG|TRACE|DBG)\b|\blevel=(debug|trace)\b|"level":\s*"(debug|trace)"/i;

export function detectLevel(line: string): LogLevel {
  const head = line.slice(0, 160);
  if (RE_ERR.test(head)) return "ERROR";
  if (RE_WARN.test(head)) return "WARN";
  if (RE_DEBUG.test(head)) return "DEBUG";
  return "INFO";
}

export function msgColor(l: LogLine): string {
  if (l.level === "ERROR") return "#ffb1ad";
  if (l.level === "DEBUG") return "#8b93a1";
  if (l.stream === "stderr") return "#e9c3bf";
  return "#d5d8de";
}

export function logQuery(mode: LogMode, follow = true): string {
  const q = new URLSearchParams();
  if (mode === "tail") q.set("tail", "200");
  else if (mode === "1h") {
    q.set("since", "1h");
    q.set("tail", "all");
  } else q.set("tail", "all");
  if (follow) q.set("follow", "1");
  return q.toString();
}

const MAX_LINES = 5000;

/**
 * Streams container logs over the logs WebSocket. While `paused`, new lines are
 * buffered and only rendered once un-paused. Buffer is capped at 5000 lines.
 */
export function useLogStream(hostId: string, containerId: string | null, mode: LogMode, paused: boolean) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "ended" | "error">("idle");
  const pending = useRef<LogLine[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    setLines([]);
    pending.current = [];
    if (!containerId) {
      setStatus("idle");
      return;
    }
    setStatus("connecting");
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const flush = () => {
      timer = null;
      if (pausedRef.current || !pending.current.length) return;
      const add = pending.current;
      pending.current = [];
      setLines((cur) => {
        const next = cur.length + add.length > MAX_LINES ? [...cur, ...add].slice(-MAX_LINES) : [...cur, ...add];
        return next;
      });
    };
    flushRef.current = flush;
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, 80);
    };
    const ws = new WebSocket(wsUrl(`/api/hosts/${hostId}/containers/${containerId}/logs/ws?${logQuery(mode)}`));
    ws.onopen = () => !closed && setStatus("live");
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      for (const raw of ev.data.split("\n")) {
        if (!raw.trim()) continue;
        let m: { t?: string; stream?: string; line?: string };
        try {
          m = JSON.parse(raw);
        } catch {
          m = { line: raw };
        }
        const text = (m.line ?? "").replace(ANSI, "").replace(/\r$/, "");
        pending.current.push({ id: ++seq, t: m.t ?? new Date().toISOString(), stream: m.stream === "stderr" ? "stderr" : "stdout", line: text, level: detectLevel(text) });
      }
      if (pending.current.length > MAX_LINES) pending.current = pending.current.slice(-MAX_LINES);
      schedule();
    };
    ws.onerror = () => !closed && setStatus("error");
    ws.onclose = () => {
      if (closed) return;
      flush();
      setStatus((s) => (s === "error" ? s : "ended"));
    };
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    };
  }, [hostId, containerId, mode]);

  // Flush buffered lines when the stream is resumed.
  useEffect(() => {
    if (!paused) flushRef.current();
  }, [paused]);

  return { lines, status, clear: () => setLines([]) };
}

/** Case-insensitive substring highlight. */
export function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(ql, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={k++} style={{ background: "rgba(224,160,32,.38)", color: "#fff", borderRadius: 3, padding: "0 1px" }}>
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

/** Keeps a scroll container pinned to the bottom while the user is at the bottom. */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

/** Rendered log rows (shared by the Logs tab and the sidecar). */
export function LogRows({ lines, filter, compact }: { lines: LogLine[]; filter: string; compact?: boolean }) {
  const q = filter.trim();
  const shown = q ? lines.filter((l) => l.line.toLowerCase().includes(q.toLowerCase())) : lines;
  return (
    <>
      {shown.map((l) => (
        <div key={l.id} className={compact ? undefined : "log-row"} style={{ display: "flex", gap: compact ? 10 : 12, whiteSpace: "pre-wrap", ...(compact ? {} : { padding: "0 6px", borderRadius: 5 }) }}>
          <span style={{ color: "#5d6470", flex: "none" }}>{clock(l.t)}</span>
          <span style={{ color: LEVEL_COLOR[l.level], width: compact ? 36 : 40, flex: "none", fontWeight: compact ? undefined : 500 }}>{compact && l.level === "DEBUG" ? "DBG" : l.level}</span>
          <span style={{ color: msgColor(l), minWidth: 0, wordBreak: "break-word" }}>{highlight(l.line, q)}</span>
        </div>
      ))}
    </>
  );
}
