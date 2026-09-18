"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { errMsg, post } from "@/lib/api";
import type { ComposeValidation } from "@/lib/types";

export interface ComposeTemplate {
  id: string;
  label: string;
  content: string;
}

// ─── YAML highlighting ─────────────────────────────────────────────────────

const K = "#7dc4ff"; // keys
const S = "#9fd18b"; // strings
const N = "#f2c05c"; // numbers / booleans
const P = "#aab1bf"; // punctuation
const C = "#5d6470"; // comments
const T = "#d5d8de"; // plain

function valueColor(v: string): string {
  const s = v.trim();
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s)) return N;
  return S;
}

function splitComment(v: string): [string, string] {
  // a " #" outside quotes starts a comment
  let q: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(v[i - 1]))) return [v.slice(0, i), v.slice(i)];
  }
  return [v, ""];
}

function highlightLine(line: string, i: number): ReactNode {
  if (/^\s*#/.test(line)) return <span key={i} style={{ color: C }}>{line}</span>;
  const m = line.match(/^(\s*)(-\s+)?([^\s:#'"][^:#]*?|"[^"]*"|'[^']*')(:)(\s|$)(.*)$/);
  if (m) {
    const [, ind, dash = "", key, colon, sp, rest] = m;
    const [val, com] = splitComment(rest);
    return (
      <span key={i}>
        {ind}
        {dash && <span style={{ color: P }}>{dash}</span>}
        <span style={{ color: K }}>{key}</span>
        <span style={{ color: P }}>{colon}</span>
        {sp}
        {val && <span style={{ color: /^\s*[|>]/.test(val) ? P : valueColor(val) }}>{val}</span>}
        {com && <span style={{ color: C }}>{com}</span>}
      </span>
    );
  }
  const d = line.match(/^(\s*)(-)(\s*)(.*)$/);
  if (d) {
    const [val, com] = splitComment(d[4]);
    return (
      <span key={i}>
        {d[1]}
        <span style={{ color: P }}>{d[2]}</span>
        {d[3]}
        <span style={{ color: valueColor(val) }}>{val}</span>
        {com && <span style={{ color: C }}>{com}</span>}
      </span>
    );
  }
  return <span key={i} style={{ color: T }}>{line}</span>;
}

// ─── Editor ────────────────────────────────────────────────────────────────

/** Editable compose editor: transparent textarea over a highlighted <pre>. */
export function ComposeEditor({ value, onChange, fileName = "docker-compose.yml", errorLine, maxHeight = 360, minHeight = 240, readOnly }: { value: string; onChange: (v: string) => void; fileName?: string; errorLine?: number; maxHeight?: number; minHeight?: number; readOnly?: boolean }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const lines = value.split("\n");

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || readOnly) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en } = el;
    if (e.shiftKey) {
      // outdent current line
      const ls = value.lastIndexOf("\n", s - 1) + 1;
      const n = value.slice(ls, ls + 2) === "  " ? 2 : value[ls] === " " ? 1 : 0;
      if (!n) return;
      onChange(value.slice(0, ls) + value.slice(ls + n));
      requestAnimationFrame(() => el.setSelectionRange(Math.max(ls, s - n), Math.max(ls, en - n)));
      return;
    }
    onChange(value.slice(0, s) + "  " + value.slice(en));
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div style={{ borderRadius: 16, background: "rgba(20,23,31,.94)", border: "1px solid rgba(255,255,255,.06)", overflow: "hidden" }}>
      <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,.07)", fontSize: 11.5, color: "#aab1bf" }}>
        <span style={{ display: "flex", color: "#7dc4ff" }}><Icon name="logs" size={14} /></span>
        {fileName}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#5d6470" }}>YAML · UTF-8</span>
      </div>
      <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.75, padding: "10px 0", maxHeight, overflow: "auto" }} onClick={() => ta.current?.focus()}>
        <div style={{ display: "flex", minWidth: "max-content", minHeight }}>
          <div aria-hidden style={{ width: 40, flex: "none", textAlign: "right", paddingRight: 12, color: "#4b5261", userSelect: "none" }}>
            {lines.map((_, i) => (
              <div key={i} style={errorLine === i + 1 ? { color: "#ff8a85", background: "rgba(226,80,76,.18)" } : undefined}>{i + 1}</div>
            ))}
          </div>
          <div style={{ position: "relative", flex: 1 }}>
            <pre aria-hidden style={{ margin: 0, padding: "0 16px 0 0", whiteSpace: "pre", font: "inherit", color: T }}>
              {lines.map((l, i) => (
                <div key={i} style={errorLine === i + 1 ? { background: "rgba(226,80,76,.14)" } : undefined}>
                  {highlightLine(l, i)}
                  {l === "" ? "​" : null}
                </div>
              ))}
            </pre>
            <textarea
              ref={ta}
              value={value}
              readOnly={readOnly}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              wrap="off"
              aria-label={fileName}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, padding: "0 16px 0 0", border: 0, outline: "none", resize: "none", overflow: "hidden", background: "transparent", color: "transparent", caretColor: "#e6e9f0", font: "inherit", lineHeight: "inherit", whiteSpace: "pre", boxShadow: "none", tabSize: 2 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Validation ────────────────────────────────────────────────────────────

export type ValidationState = { status: "idle" } | { status: "checking" } | { status: "done"; result: ComposeValidation } | { status: "error"; error: string };

/** Debounced (400 ms) server-side validation. */
export function useComposeValidation(content: string, enabled = true): ValidationState {
  const [state, setState] = useState<ValidationState>({ status: "idle" });
  useEffect(() => {
    if (!enabled || !content.trim()) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState((s) => (s.status === "done" ? s : { status: "checking" }));
    const t = setTimeout(async () => {
      try {
        const r = await post<ComposeValidation>("/api/compose/validate", { content });
        if (alive) setState({ status: "done", result: r });
      } catch (e) {
        if (alive) setState({ status: "error", error: errMsg(e) });
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [content, enabled]);
  return state;
}

export function ValidationLine({ state }: { state: ValidationState }) {
  if (state.status === "idle") return <span style={{ fontSize: 12.5, color: "var(--ink-3)", fontWeight: 600 }}>Empty file</span>;
  if (state.status === "checking")
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-3)", fontWeight: 600 }}>
        <span className="spinner" style={{ width: 11, height: 11 }} />
        Validating…
      </span>
    );
  if (state.status === "error") return <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>Couldn&apos;t validate: {state.error}</span>;
  const r = state.result;
  if (r.ok)
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ok-ink)", fontWeight: 600 }}>
        <Icon name="checkCircle" size={15} />
        Valid · {r.services.length} service{r.services.length === 1 ? "" : "s"}
      </span>
    );
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600, minWidth: 0 }}>
      <Icon name="alert" size={15} />
      <span>{r.line ? `Line ${r.line}: ` : ""}{r.error || "Invalid compose file"}</span>
    </span>
  );
}

export function isValid(state: ValidationState) {
  return state.status === "done" && state.result.ok;
}

/** Template chips ("Start from"). */
export function TemplateChips({ templates, value, onPick }: { templates: ComposeTemplate[]; value: string; onPick: (t: ComposeTemplate) => void }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {templates.map((t) => (
        <button key={t.id} type="button" className={`choice ${t.id === value ? "on" : ""}`} onClick={() => onPick(t)} style={{ height: 34, padding: "0 14px", fontSize: 12.5, fontWeight: 600 }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
