"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { useApi } from "@/lib/api";
import type { Container, Host } from "@/lib/types";
import { copyText, useOutside } from "../ui";
import { Icon, type IconName } from "../icons";
import { useShell, type TerminalTarget } from "./context";
import { XTerm } from "../host/XTerm";
import { LogsView, type LogStatus } from "../host/LogsTab";
import { HoverStyles } from "../host/HoverStyles";

// ─── Geometry (persisted) ──────────────────────────────────────────────────

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORE = "dockhand.terminal.window";
const HEAD = 44;
const MIN_W = 420;
const MIN_H = 240;
const FONT_MIN = 10;
const FONT_MAX = 20;

function vp() {
  return { vw: window.innerWidth, vh: window.innerHeight };
}

function clamp(g: Geom): Geom {
  const { vw, vh } = vp();
  const w = Math.max(Math.min(MIN_W, vw - 16), Math.min(g.w, vw - 16));
  const h = Math.max(Math.min(MIN_H, vh - 16), Math.min(g.h, vh - 16));
  const x = Math.min(Math.max(g.x, 160 - w), vw - 160);
  const y = Math.min(Math.max(g.y, 8), vh - HEAD - 8);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function defaultGeom(): Geom {
  const { vw, vh } = vp();
  const w = Math.min(860, vw - 32);
  const h = Math.min(500, vh - 120);
  return clamp({ x: vw - w - 24, y: vh - h - 24, w, h });
}

function loadStore(): { geom: Geom; font: number } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Geom & { font: number }>;
      if ([s.x, s.y, s.w, s.h].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return { geom: clamp(s as Geom), font: typeof s.font === "number" ? Math.min(FONT_MAX, Math.max(FONT_MIN, s.font)) : 13 };
      }
    }
  } catch {
    /* storage unavailable */
  }
  return { geom: defaultGeom(), font: 13 };
}

function saveStore(g: Geom, font: number) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...g, font }));
  } catch {
    /* ignore */
  }
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

interface Tab {
  key: string;
  target: TerminalTarget;
}

interface TabStatus {
  state: "connecting" | "open" | "ended" | "error" | "paused";
  latency?: number;
  cols?: number;
  rows?: number;
  lines?: number;
}

function sameTarget(a: TerminalTarget, b: TerminalTarget): boolean {
  if (a.kind !== b.kind || a.hostId !== b.hostId) return false;
  if (a.kind === "shell") return true;
  return a.containerId === (b as { containerId: string }).containerId;
}

const KIND: Record<TerminalTarget["kind"], { icon: IconName; color: string }> = {
  shell: { icon: "terminal", color: "#9fd18b" },
  exec: { icon: "box", color: "#7dc4ff" },
  logs: { icon: "logs", color: "#f2c05c" },
};

let tabSeq = 0;

/**
 * Floating terminal window (v2 design). `requests` is append-only: every new `seq`
 * opens a tab for its target, or focuses the tab that already shows it.
 */
export function TerminalWindow({ requests, onClose }: { requests: { target: TerminalTarget; seq: number }[]; onClose: () => void }) {
  const { toast } = useShell();
  const init = useMemo(loadStore, []);
  const [geom, setGeom] = useState<Geom>(init.geom);
  const [font, setFont] = useState(init.font);
  const [maxed, setMaxed] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [drag, setDrag] = useState<null | "move" | "se" | "e" | "s">(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, TabStatus>>({});
  const [plusOpen, setPlusOpen] = useState(false);
  const [vpSize, setVpSize] = useState(vp);
  const rootRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLSpanElement>(null);
  useOutside(plusRef, () => setPlusOpen(false), plusOpen);

  const { data: hosts } = useApi<Host[]>("/api/hosts", { refresh: 30000 });
  const { data: containers } = useApi<Container[]>("/api/containers", { refresh: plusOpen ? 5000 : 30000 });
  const hostById = useMemo(() => new Map((hosts ?? []).map((h) => [h.id, h])), [hosts]);
  const ctrById = useMemo(() => new Map((containers ?? []).map((c) => [`${c.hostId}/${c.id}`, c])), [containers]);

  // Handles to session output, for "copy output".
  const terms = useRef(new Map<string, Terminal>());
  const logText = useRef(new Map<string, () => string>());
  const connectAt = useRef(new Map<string, number>());

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const addTab = useCallback((target: TerminalTarget, forceNew = false) => {
    const cur = tabsRef.current;
    const existing = forceNew ? undefined : cur.find((t) => sameTarget(t.target, target));
    if (existing) {
      setActive(existing.key);
      return;
    }
    const key = `t${++tabSeq}`;
    const next = [...cur, { key, target }];
    tabsRef.current = next;
    setTabs(next);
    setActive(key);
  }, []);

  // New requests → open / focus tabs.
  const seen = useRef(0);
  useEffect(() => {
    const fresh = requests.filter((r) => r.seq > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((r) => r.seq));
    fresh.forEach((r) => addTab(r.target));
    setMinimized(false);
    rootRef.current?.focus({ preventScroll: true });
  }, [requests, addTab]);

  const closeTab = (key: string) => {
    const next = tabs.filter((t) => t.key !== key);
    terms.current.delete(key);
    logText.current.delete(key);
    if (!next.length) {
      onClose();
      return;
    }
    tabsRef.current = next;
    setTabs(next);
    if (active === key) {
      const i = tabs.findIndex((t) => t.key === key);
      setActive(next[Math.min(i, next.length - 1)].key);
    }
  };

  // Keep the window on screen when the viewport changes.
  useEffect(() => {
    const onResize = () => {
      setVpSize(vp());
      setGeom((g) => clamp(g));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Drag / resize.
  const start = useRef<{ mx: number; my: number; g: Geom } | null>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const fontRef = useRef(font);
  fontRef.current = font;
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.mx;
      const dy = e.clientY - s.my;
      if (drag === "move") setGeom(clamp({ ...s.g, x: s.g.x + dx, y: s.g.y + dy }));
      else setGeom(clamp({ ...s.g, w: drag === "s" ? s.g.w : Math.max(MIN_W, s.g.w + dx), h: drag === "e" ? s.g.h : Math.max(MIN_H, s.g.h + dy) }));
    };
    const up = () => {
      setDrag(null);
      start.current = null;
      saveStore(geomRef.current, fontRef.current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag]);

  const beginDrag = (mode: "move" | "se" | "e" | "s") => (e: React.MouseEvent) => {
    if (e.button !== 0 || maxed) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button, input, [data-nodrag]")) return;
    if (mode !== "move" && minimized) return;
    e.preventDefault();
    start.current = { mx: e.clientX, my: e.clientY, g: geomRef.current };
    setDrag(mode);
  };

  const setFontSize = (f: number) => {
    const v = Math.min(FONT_MAX, Math.max(FONT_MIN, f));
    setFont(v);
    saveStore(geomRef.current, v);
  };

  const cur = tabs.find((t) => t.key === active) ?? null;
  const curStatus = cur ? status[cur.key] : undefined;
  const patchStatus = useCallback((key: string, p: Partial<TabStatus>) => {
    setStatus((m) => {
      const prev = m[key] ?? { state: "connecting" };
      const next = { ...prev, ...p };
      if ((Object.keys(p) as (keyof TabStatus)[]).every((k) => prev[k] === next[k])) return m;
      return { ...m, [key]: next };
    });
  }, []);

  const label = (t: TerminalTarget): string => {
    const h = hostById.get(t.hostId);
    if (t.kind === "shell") return h ? `${h.user || "root"}@${h.name}` : "host shell";
    const name = t.name ?? ctrById.get(`${t.hostId}/${t.containerId}`)?.name ?? t.containerId.slice(0, 12);
    return t.kind === "logs" ? `${name} · logs` : name;
  };

  const meta = (t: TerminalTarget): string => {
    const h = hostById.get(t.hostId);
    const name = t.kind === "shell" ? "" : t.name ?? ctrById.get(`${t.hostId}/${t.containerId}`)?.name ?? t.containerId.slice(0, 12);
    if (t.kind === "shell") return h ? `ssh ${h.user || "root"}@${h.address}${h.port && h.port !== 22 ? ` -p ${h.port}` : ""}` : "ssh";
    const on = h ? ` · ${h.name}` : "";
    return t.kind === "exec" ? `docker exec -it ${name} /bin/sh${on}` : `docker logs -f ${name}${on}`;
  };

  const copyOutput = async () => {
    if (!cur) return;
    let text = "";
    const term = terms.current.get(cur.key);
    if (term) {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
      while (out.length && !out[out.length - 1].trim()) out.pop();
      text = out.join("\n");
    } else {
      text = logText.current.get(cur.key)?.() ?? "";
    }
    if (!text) {
      toast({ kind: "info", title: "Nothing to copy yet" });
      return;
    }
    await copyText(text);
    const n = text.split("\n").length;
    toast({ kind: "ok", title: `Copied ${n} line${n === 1 ? "" : "s"}` });
  };

  // "+" menu: host shells (SSH hosts), then container shells and logs.
  const runningByHost = useMemo(() => {
    const m = new Map<string, Container[]>();
    for (const c of containers ?? []) {
      if (c.state !== "running" || !hostById.has(c.hostId)) continue;
      const arr = m.get(c.hostId) ?? [];
      arr.push(c);
      m.set(c.hostId, arr);
    }
    m.forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)));
    return m;
  }, [containers, hostById]);
  const sshHosts = (hosts ?? []).filter((h) => h.method !== "local" && h.status !== "offline" && h.status !== "pending");
  const multiHost = (hosts ?? []).length > 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Escape inside a shell belongs to the shell (vim, less…). Stop it reaching the sidecar either way.
    e.stopPropagation();
    if ((e.target as HTMLElement).closest?.(".xterm")) return;
    if (plusOpen) {
      setPlusOpen(false);
      return;
    }
    if (document.querySelector(".dialog-scrim")) return;
    onClose();
  };

  const g = maxed ? { x: 12, y: 12, w: vpSize.vw - 24, h: vpSize.vh - 24 } : geom;
  const height = minimized ? HEAD : g.h;
  const dotColor = !curStatus ? "#f2c05c" : curStatus.state === "open" ? "#3ccf7a" : curStatus.state === "paused" ? "#aab1bf" : curStatus.state === "connecting" ? "#f2c05c" : "#ff5f57";
  const stateText = !cur
    ? ""
    : cur.target.kind === "logs"
      ? curStatus?.state === "open"
        ? "streaming"
        : curStatus?.state === "paused"
          ? "paused"
          : curStatus?.state === "connecting" || !curStatus
            ? "connecting…"
            : curStatus.state === "error"
              ? "stream failed"
              : "stream ended"
      : curStatus?.state === "open"
        ? `connected${curStatus.latency != null ? ` · ${curStatus.latency}ms` : ""}`
        : curStatus?.state === "ended"
          ? "disconnected"
          : "connecting…";
  const sizeText = !cur ? "" : cur.target.kind === "logs" ? `${curStatus?.lines ?? 0} lines` : curStatus?.cols ? `${curStatus.cols}×${curStatus.rows}` : "";

  return (
    <div
      ref={rootRef}
      data-terminal-window
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label="Terminal"
      style={{
        position: "fixed",
        left: g.x,
        top: g.y,
        width: g.w,
        height,
        zIndex: 88,
        borderRadius: maxed ? 14 : 18,
        background: "#15181f",
        color: "#e6e9f0",
        boxShadow: "0 30px 90px rgba(5,8,16,.5), 0 0 0 1px rgba(255,255,255,.08), inset 0 1px 0 rgba(255,255,255,.06)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        animation: "pop .28s cubic-bezier(.2,.8,.2,1) both",
        userSelect: drag ? "none" : undefined,
        outline: "none",
        transition: drag ? "none" : "height .22s cubic-bezier(.2,.8,.2,1), border-radius .2s",
      }}
    >
      <HoverStyles />
      {/* Title bar: drag to move, double-click to maximise. */}
      <div
        onMouseDown={beginDrag("move")}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, [data-nodrag]")) return;
          setMaxed(!maxed);
          setMinimized(false);
        }}
        style={{ display: "flex", alignItems: "center", gap: 8, height: HEAD, padding: "0 10px 0 12px", background: "#1c2029", borderBottom: "1px solid rgba(255,255,255,.07)", cursor: maxed ? "default" : drag === "move" ? "grabbing" : "grab", flex: "none", minWidth: 0 }}
      >
        <span style={{ display: "flex", gap: 7, marginRight: 6, flex: "none" }}>
          <button onClick={onClose} title="Close" aria-label="Close terminal" style={{ ...LIGHT, background: "#ff5f57" }} />
          <button onClick={() => setMinimized(!minimized)} title={minimized ? "Restore" : "Shrink"} aria-label={minimized ? "Restore" : "Shrink"} style={{ ...LIGHT, background: "#febc2e" }} />
          <button
            onClick={() => {
              setMaxed(!maxed);
              setMinimized(false);
            }}
            title={maxed ? "Restore size" : "Maximize"}
            aria-label={maxed ? "Restore size" : "Maximize"}
            style={{ ...LIGHT, background: "#28c840" }}
          />
        </span>
        <div style={{ display: "flex", alignItems: "stretch", gap: 2, minWidth: 0, height: HEAD, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none" }}>
          {tabs.map((t) => {
            const on = t.key === active;
            const k = KIND[t.target.kind];
            return (
              <button
                key={t.key}
                className="term-tab"
                onClick={() => {
                  setActive(t.key);
                  setMinimized(false);
                }}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(t.key);
                  }
                }}
                title={meta(t.target)}
                style={{ position: "relative", height: HEAD - 6, padding: "0 10px 0 14px", border: 0, background: on ? "#15181f" : "transparent", color: on ? "#fff" : "#aab1bf", fontSize: 12.5, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", flex: "none", borderRadius: "10px 10px 0 0", marginTop: 6, maxWidth: 220 }}
              >
                <Icon name={k.icon} size={13} color={k.color} strokeWidth={2.2} />
                <span className={t.target.kind === "shell" ? "mono ellipsis" : "ellipsis"} style={{ fontSize: t.target.kind === "shell" ? 12 : 12.5 }}>{label(t.target)}</span>
                <span
                  role="button"
                  aria-label="Close tab"
                  className="term-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.key);
                  }}
                  style={{ marginLeft: 2, width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", opacity: 0.5, fontSize: 11, flex: "none" }}
                >
                  ✕
                </span>
                <span style={{ position: "absolute", left: 10, right: 10, bottom: 0, height: 2, borderRadius: 1, background: on ? k.color : "transparent" }} />
              </button>
            );
          })}
        </div>
        <span ref={plusRef} data-nodrag style={{ position: "relative", display: "flex", alignItems: "center", flex: "none" }}>
          <button className="term-plus" onClick={() => setPlusOpen(!plusOpen)} title="New session" aria-label="New session" style={{ height: 28, width: 28, border: 0, borderRadius: 8, background: "transparent", color: "#aab1bf", fontSize: 16, cursor: "pointer", marginLeft: 4 }}>
            +
          </button>
          {plusOpen && (
            <div style={{ position: "absolute", left: 0, top: 36, minWidth: 260, maxHeight: Math.max(160, Math.min(340, (minimized ? vpSize.vh - g.y : g.h) - 60)), overflow: "auto", zIndex: 30, padding: 6, borderRadius: 14, background: "rgba(28,32,41,.98)", border: "1px solid rgba(255,255,255,.1)", boxShadow: "0 18px 50px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 2, animation: "pop .18s ease both", cursor: "default" }}>
              <MenuLabel>New tab</MenuLabel>
              {sshHosts.map((h) => (
                <MenuBtn
                  key={`sh-${h.id}`}
                  dot="#9fd18b"
                  icon="terminal"
                  label={`${h.user || "root"}@${h.name}`}
                  sub="ssh"
                  onClick={() => {
                    setPlusOpen(false);
                    addTab({ kind: "shell", hostId: h.id }, true);
                    setMinimized(false);
                  }}
                />
              ))}
              {(hosts ?? []).map((h) => {
                const list = runningByHost.get(h.id);
                if (!list?.length) return null;
                return (
                  <div key={`c-${h.id}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <MenuLabel>{multiHost ? `Containers · ${h.name}` : "Containers"}</MenuLabel>
                    {list.map((c) => (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                        <MenuBtn
                          dot="#3ccf7a"
                          icon="box"
                          label={c.name}
                          sub="shell"
                          onClick={() => {
                            setPlusOpen(false);
                            addTab({ kind: "exec", hostId: h.id, containerId: c.id, name: c.name }, true);
                            setMinimized(false);
                          }}
                        />
                        <button
                          className="dk-menu-item"
                          title={`Logs: ${c.name}`}
                          onClick={() => {
                            setPlusOpen(false);
                            addTab({ kind: "logs", hostId: h.id, containerId: c.id, name: c.name });
                            setMinimized(false);
                          }}
                          style={{ height: 32, padding: "0 10px", border: 0, borderRadius: 9, background: "transparent", color: "#aab1bf", fontSize: 11.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: "none" }}
                        >
                          <Icon name="logs" size={12} color="#f2c05c" strokeWidth={2.2} />
                          logs
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {!sshHosts.length && runningByHost.size === 0 && <div style={{ padding: "6px 10px 8px", fontSize: 12, color: "#6b7280" }}>{containers ? "No hosts or running containers to connect to." : "Loading…"}</div>}
            </div>
          )}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {g.w >= 560 && <span className="mono" style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260, minWidth: 0 }}>{cur ? meta(cur.target) : ""}</span>}
        <button className="term-plus" onClick={copyOutput} title="Copy output" aria-label="Copy output" style={{ height: 28, width: 28, border: 0, borderRadius: 8, background: "transparent", color: "#aab1bf", cursor: "pointer", display: "grid", placeItems: "center", flex: "none" }}>
          <Icon name="copy" size={14} />
        </button>
      </div>

      {/* Sessions stay mounted while hidden so shells keep running. */}
      <div style={{ flex: 1, minHeight: 0, display: minimized ? "none" : "flex", flexDirection: "column", background: "#15181f" }}>
        {tabs.map((t) => {
          const on = t.key === active && !minimized;
          if (t.target.kind === "logs") {
            const tg = t.target;
            return (
              <LogsView
                key={t.key}
                hostId={tg.hostId}
                containerId={tg.containerId}
                name={tg.name ?? ctrById.get(`${tg.hostId}/${tg.containerId}`)?.name ?? tg.containerId.slice(0, 12)}
                active={t.key === active}
                fontSize={Math.max(FONT_MIN, font - 1)}
                onText={(fn) => {
                  if (fn) logText.current.set(t.key, fn);
                  else logText.current.delete(t.key);
                }}
                onStatus={(s: LogStatus, lines, live) => patchStatus(t.key, { state: !live ? "paused" : s === "live" ? "open" : s === "idle" ? "connecting" : s, lines })}
              />
            );
          }
          const path = t.target.kind === "shell" ? `/api/hosts/${t.target.hostId}/shell` : `/api/hosts/${t.target.hostId}/containers/${t.target.containerId}/exec?cmd=${encodeURIComponent("/bin/sh")}`;
          return (
            <XTerm
              key={t.key}
              path={path}
              active={on}
              fontSize={font}
              onReady={(term) => {
                if (term) terms.current.set(t.key, term);
                else terms.current.delete(t.key);
              }}
              onDims={(d) => patchStatus(t.key, { cols: d.cols, rows: d.rows })}
              onState={(s) => {
                if (s === "connecting") {
                  connectAt.current.set(t.key, performance.now());
                  patchStatus(t.key, { state: "connecting" });
                } else if (s === "open") {
                  const at = connectAt.current.get(t.key);
                  patchStatus(t.key, { state: "open", latency: at != null ? Math.round(performance.now() - at) : undefined });
                } else patchStatus(t.key, { state: "ended" });
              }}
            />
          );
        })}
      </div>

      {!minimized && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 12px", fontSize: 11, color: "#6b7280", borderTop: "1px solid rgba(255,255,255,.06)", background: "#1c2029", flex: "none", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, boxShadow: `0 0 8px ${dotColor}` }} />
            {stateText}
          </span>
          <span className="mono" style={{ whiteSpace: "nowrap" }}>{sizeText}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
            <button className="dk-btn" onClick={() => setFontSize(font - 1)} disabled={font <= FONT_MIN} title="Smaller text" aria-label="Smaller text" style={FONT_BTN}>
              −
            </button>
            <button className="dk-btn" onClick={() => setFontSize(font + 1)} disabled={font >= FONT_MAX} title="Larger text" aria-label="Larger text" style={FONT_BTN}>
              +
            </button>
            <kbd className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 6, background: "rgba(255,255,255,.08)", marginLeft: 6 }}>esc</kbd> close
          </span>
        </div>
      )}

      {!minimized && !maxed && (
        <>
          <span onMouseDown={beginDrag("se")} title="Resize" style={{ position: "absolute", right: 0, bottom: 0, width: 22, height: 22, cursor: "nwse-resize", display: "grid", placeItems: "center", color: "#4b5261", zIndex: 2 }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 1L1 9M9 5L5 9M9 9h0" />
            </svg>
          </span>
          <span onMouseDown={beginDrag("e")} style={{ position: "absolute", right: 0, top: HEAD, bottom: 22, width: 6, cursor: "ew-resize", zIndex: 2 }} />
          <span onMouseDown={beginDrag("s")} style={{ position: "absolute", left: 0, right: 22, bottom: 0, height: 6, cursor: "ns-resize", zIndex: 2 }} />
        </>
      )}
    </div>
  );
}

const LIGHT: React.CSSProperties = { width: 12, height: 12, borderRadius: "50%", border: 0, cursor: "pointer", padding: 0, flex: "none" };
const FONT_BTN: React.CSSProperties = { height: 20, width: 20, border: 0, borderRadius: 5, background: "rgba(255,255,255,.06)", color: "#aab1bf", cursor: "pointer", fontSize: 11, padding: 0 };

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#6b7280", padding: "6px 10px 2px" }}>{children}</div>;
}

function MenuBtn({ onClick, dot, icon, label, sub }: { onClick: () => void; dot: string; icon: IconName; label: string; sub?: string }) {
  return (
    <button className="dk-menu-item mono" onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, height: 32, padding: "0 10px", border: 0, borderRadius: 9, background: "transparent", color: "#e6e9f0", fontSize: 12.5, cursor: "pointer", textAlign: "left", flex: 1, minWidth: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flex: "none" }} />
      <Icon name={icon} size={12} color="#aab1bf" strokeWidth={2} />
      <span className="ellipsis" style={{ flex: 1 }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--font)" }}>{sub}</span>}
    </button>
  );
}
