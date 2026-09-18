"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";
import { Dialog, DialogHeader, copyText } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, post } from "@/lib/api";
import { C } from "@/lib/format";
import type { DeployCheckInput, DeployCheckResult, DeployIssue, DryRunResult, KV } from "@/lib/types";

// Local hover / responsive rules for the deploy screens (globals.css is shared).
export function DeployStyles() {
  return (
    <style>{`
      .dh-lift { transition: transform .2s, box-shadow .2s; }
      .dh-lift:hover { transform: translateY(-2px); box-shadow: 0 16px 40px rgba(30,40,70,.1) !important; }
      .dh-rm:hover { background: var(--fill-2) !important; }
      .dh-add:hover { border-color: var(--ink) !important; color: var(--ink) !important; }
      .dh-chip:hover { background: var(--surface) !important; }
      .dh-filt:hover { color: var(--ink) !important; }
      .dh-targets button:hover { background: var(--fill-2) !important; }
      @media (min-width: 900px) { .dh-sticky { position: sticky; top: 90px; } }
    `}</style>
  );
}

export const cardStyle: CSSProperties = { borderRadius: 22, padding: "20px 22px", display: "flex", flexDirection: "column" };

/** Deploy-page stepper (slightly larger than the dialog one). */
export function DeployStepper({ current, steps = ["Choose", "Configure", "Deploy"] }: { current: number; steps?: string[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {steps.map((s, i) => {
        const on = i === current;
        const done = i < current;
        return (
          <span key={s} style={{ display: "contents" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 6px 6px", borderRadius: 12, background: on ? "var(--surface)" : "transparent", boxShadow: on ? "0 2px 8px rgba(30,40,70,.1)" : "none", fontSize: 13, fontWeight: 600, color: on ? "var(--ink)" : done ? "var(--ink-2)" : "var(--ink-3)", whiteSpace: "nowrap" }}>
              <span className="mono" style={{ width: 22, height: 22, borderRadius: 7, background: on ? "var(--btn)" : done ? "var(--ok)" : "var(--fill-1)", color: on ? "var(--btn-ink)" : done ? "#fff" : "var(--ink-3)", display: "grid", placeItems: "center", fontSize: 11.5 }}>
                {done ? "✓" : i + 1}
              </span>
              {s}
            </div>
            {i < steps.length - 1 && <span style={{ width: 28, height: 1, background: "var(--line-3)", flex: "none" }} />}
          </span>
        );
      })}
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back-btn" onClick={onClick} aria-label="Back" style={{ color: "var(--ink)" }}>
      ←
    </button>
  );
}

export function BigButton({ icon = "deploy", children, onClick, disabled, busy, blocked }: { icon?: IconName; children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; blocked?: boolean }) {
  return (
    <button type="button" className="btn lg" onClick={onClick} disabled={disabled || busy || blocked} style={{ width: "100%", gap: 10, ...(blocked ? { opacity: 0.45, pointerEvents: "none" } : null) }}>
      {busy ? <span className="spinner" /> : <Icon name={icon} size={17} color="#9fd18b" strokeWidth={2.2} />}
      {children}
    </button>
  );
}

// ─── .env handling ─────────────────────────────────────────────────────────

export function parseDotenv(text: string): KV[] {
  const out: KV[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out.push({ k: m[1], v });
  }
  return out;
}

/** Inline "paste or upload a .env" panel. */
export function EnvImport({ onMerge, onClose }: { onMerge: (vars: KV[]) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const parsed = parseDotenv(text);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 14, background: "var(--fill-1)", animation: "rise .25s ease both" }}>
      <textarea
        className="input mono"
        autoFocus
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"# paste a .env file\nDATABASE_URL=postgres://…\nSECRET_KEY=…"}
        style={{ fontSize: 12, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input
          ref={file}
          type="file"
          accept=".env,.txt,text/plain"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
            e.target.value = "";
          }}
        />
        <button type="button" className="btn2 sm" onClick={() => file.current?.click()}>
          <Icon name="download" size={13} style={{ transform: "rotate(180deg)" }} />
          Upload file
        </button>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{parsed.length ? `${parsed.length} variable${parsed.length === 1 ? "" : "s"} found` : "KEY=value per line"}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" className="btn2 sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn xs"
            disabled={!parsed.length}
            onClick={() => {
              onMerge(parsed);
              onClose();
            }}
          >
            Merge
          </button>
        </span>
      </div>
    </div>
  );
}

// ─── Pair rows (ports / volumes / env) ─────────────────────────────────────

export interface Pair {
  a: string;
  b: string;
}

const pairInput: CSSProperties = { height: 36, fontSize: 12.5 };

export function PairRows({ rows, onChange, sep, phA, phB }: { rows: Pair[]; onChange: (rows: Pair[]) => void; sep: string; phA: string; phB: string }) {
  const set = (i: number, p: Partial<Pair>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 20px minmax(0,1fr) 32px", gap: 6, alignItems: "center" }}>
          <input className="input mono" style={pairInput} value={r.a} placeholder={phA} onChange={(e) => set(i, { a: e.target.value })} />
          <span style={{ textAlign: "center", color: "var(--ink-3)", fontSize: 12 }}>{sep}</span>
          <input className="input mono" style={pairInput} value={r.b} placeholder={phB} onChange={(e) => set(i, { b: e.target.value })} />
          <button type="button" className="dh-rm" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))} style={{ width: 32, height: 36, borderRadius: 10, border: 0, background: "var(--fill-1)", cursor: "pointer", color: "var(--ink-3)", fontSize: 14 }}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="dh-add" onClick={() => onChange([...rows, { a: "", b: "" }])} style={{ alignSelf: "flex-start", height: 30, padding: "0 10px", borderRadius: 9, border: "1px dashed var(--line-3)", background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="plus" size={13} strokeWidth={2.2} />
        Add
      </button>
    </div>
  );
}

/** Chip-style option button (registries). */
export function ChipButton({ on, children, onClick }: { on: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ height: 28, padding: "0 10px", borderRadius: 9, border: `1px solid ${on ? "var(--blue)" : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--ink)" }}>
      {children}
    </button>
  );
}

export function SummaryRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "8px 0", borderBottom: "1px solid var(--line-1)" }}>
      <span style={{ color: "var(--ink-3)", flex: "none" }}>{k}</span>
      <span className="mono ellipsis" style={{ fontSize: 12, textAlign: "right", minWidth: 0 }}>{v}</span>
    </div>
  );
}

export function hashColor(s: string, palette: string[]): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// ─── Pre-flight checks (POST /api/deploy/check) ────────────────────────────

/** Debounce-runs the deploy pre-flight check ~500 ms after `input` changes. `null` skips. */
export function useDeployCheck(input: DeployCheckInput | null) {
  const key = input ? JSON.stringify(input) : "";
  const [result, setResult] = useState<DeployCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!key) {
      setResult(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await post<DeployCheckResult>("/api/deploy/check", JSON.parse(key));
        if (n === seq.current) setResult({ ok: r.ok, issues: r.issues ?? [] });
      } catch {
        // The check is advisory: if it can't run, never block the deploy.
        if (n === seq.current) setResult(null);
      } finally {
        if (n === seq.current) setChecking(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [key]);
  const issues = result?.issues ?? [];
  const crit = issues.filter((i) => i.severity === "crit").length;
  const warn = issues.length - crit;
  return { result, issues, crit, warn, checking };
}

const s = (n: number) => (n === 1 ? "" : "s");

export function issueTitle(crit: number, warn: number): string {
  if (crit) return `${crit} thing${s(crit)} to fix before deploying${warn ? ` · ${warn} warning${s(warn)}` : ""}`;
  return `${warn} warning${s(warn)}`;
}

/** The deploy button label for the current check state. */
export function deployBtnLabel(crit: number, warn: number, hostName: string | undefined): string {
  if (crit) return `Fix ${crit} issue${s(crit)} to deploy`;
  if (warn) return "Deploy anyway";
  return `Deploy to ${hostName ?? "…"}`;
}

/** "Issues" card shown above the deploy button (design: hasIssues / issueTitle / issues). */
export function IssuesPanel({ issues, crit, warn, canFix, onFix }: { issues: DeployIssue[]; crit: number; warn: number; canFix?: (i: DeployIssue) => boolean; onFix: (i: DeployIssue) => void }) {
  if (!issues.length) return null;
  return (
    <div className="glass-card" style={{ borderRadius: 18, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8, animation: "rise .25s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700 }}>
        <Icon name="alert" size={16} color={crit ? C.crit : C.warn} />
        {issueTitle(crit, warn)}
      </div>
      {issues.map((i, n) => {
        const color = i.severity === "crit" ? C.crit : C.warn;
        const fixable = i.fix && (canFix ? canFix(i) : true);
        return (
          <div key={`${i.field}-${n}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.45, padding: "8px 10px", borderRadius: 10, background: i.severity === "crit" ? "rgba(226,80,76,.09)" : "rgba(224,160,32,.11)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, marginTop: 6, flex: "none" }} />
            <span style={{ flex: 1, minWidth: 0, color: "var(--ink-2)" }}>
              <strong style={{ color: "var(--ink)", fontWeight: 700 }}>{i.field}</strong> — {i.text}
            </span>
            {fixable && (
              <button type="button" onClick={() => onFix(i)} style={{ height: 24, padding: "0 9px", borderRadius: 7, border: 0, background: "var(--btn)", color: "var(--btn-ink)", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>
                {i.fix!.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Merge env values from a fix patch into KV-ish rows. */
export function mergeKV<T>(rows: T[], vars: KV[], key: (r: T) => string, set: (r: T | null, kv: KV) => T): T[] {
  const next = [...rows];
  for (const kv of vars) {
    const i = next.findIndex((r) => key(r) === kv.k);
    if (i >= 0) next[i] = set(next[i], kv);
    else next.push(set(null, kv));
  }
  return next;
}

// ─── Dry run ───────────────────────────────────────────────────────────────

/** "Dry run" secondary button + result dialog. `run` performs the request. */
export function DryRunButton({ label, title, sub, run, disabled }: { label: string; title: string; sub?: string; run: () => Promise<DryRunResult>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; result?: DryRunResult; error?: string }>({ loading: false });
  const start = async () => {
    setOpen(true);
    setState({ loading: true });
    try {
      setState({ loading: false, result: await run() });
    } catch (e) {
      setState({ loading: false, error: errMsg(e) });
    }
  };
  return (
    <>
      <button type="button" className="btn2 lg" style={{ height: 38, width: "100%" }} onClick={start} disabled={disabled || state.loading}>
        {state.loading && <span className="spinner" style={{ width: 12, height: 12 }} />}
        {label}
      </button>
      {open && typeof document !== "undefined" && createPortal(<DryRunDialog title={title} sub={sub} state={state} onRetry={start} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function DryRunDialog({ title, sub, state, onRetry, onClose }: { title: string; sub?: string; state: { loading: boolean; result?: DryRunResult; error?: string }; onRetry: () => void; onClose: () => void }) {
  const { toast } = useShell();
  const r = state.result;
  const failed = !!state.error || (r && !r.ok);
  const output = state.error ?? r?.output ?? "";
  const copy = async (text: string, what: string) => {
    await copyText(text);
    toast({ kind: "ok", title: `Copied ${what}` });
  };
  return (
    <Dialog onClose={onClose} width={680}>
      <DialogHeader icon="terminal" title={title} sub={sub} monoSub onClose={onClose} />
      {r?.command && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "var(--fill-1)" }}>
          <span className="mono" style={{ color: "var(--ink-3)", fontSize: 12 }}>$</span>
          <code className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink-4)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.command}</code>
          <button type="button" className="btn-fill" style={{ padding: "0 10px", flex: "none" }} onClick={() => copy(r.command, "command")}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: state.loading ? "var(--ink-3)" : failed ? "var(--crit-ink)" : "var(--ok-ink)" }}>
        {state.loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <span className="dot" style={{ background: failed ? C.crit : C.ok }} />}
        {state.loading ? "Rendering configuration…" : failed ? "Dry run failed — nothing was changed" : "Configuration is valid — nothing was changed"}
      </div>
      <div className="term-block" style={{ minHeight: 160, maxHeight: "min(52vh, 460px)", overflow: "auto", fontSize: 11.5, color: failed ? "#ff8a85" : "var(--term-ink)", wordBreak: "break-word" }}>
        {state.loading ? <span style={{ color: "#6b7280" }}>…</span> : output || <span style={{ color: "#6b7280" }}>(no output)</span>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {failed && !state.loading && <button type="button" className="btn2 lg" onClick={onRetry}>Retry</button>}
        <button type="button" className="btn2 lg" disabled={!output || state.loading} onClick={() => copy(output, "output")}>
          <Icon name="copy" size={14} />
          Copy output
        </button>
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
