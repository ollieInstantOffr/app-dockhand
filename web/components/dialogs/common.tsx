"use client";

import type { CSSProperties, ReactNode } from "react";
import { useApi } from "@/lib/api";
import type { Host } from "@/lib/types";

export function Actions({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", alignItems: "center", ...style }}>{children}</div>;
}

export function Field({ label, children, hint, style }: { label: ReactNode; children: ReactNode; hint?: ReactNode; style?: CSSProperties }) {
  return (
    <label className="field" style={style}>
      {label}
      {children}
      {hint != null && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Non-label field wrapper (for groups of buttons, where a <label> would steal clicks). */
export function Group({ label, children, style }: { label: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="field" style={style}>
      {label}
      {children}
    </div>
  );
}

export function useHosts() {
  const q = useApi<Host[]>("/api/hosts");
  return q.data ?? [];
}

export function Callout({ kind, children }: { kind: "ok" | "warn" | "crit" | "info"; children: ReactNode }) {
  const s: Record<string, CSSProperties> = {
    ok: { background: "rgba(34,160,107,.1)", border: "1px solid rgba(34,160,107,.3)", color: "var(--ok-ink)" },
    warn: { background: "var(--warn-bg)", color: "var(--warn-ink)" },
    crit: { background: "var(--crit-bg)", color: "var(--crit-ink)" },
    info: { background: "rgba(47,111,237,.06)", border: "1px solid rgba(47,111,237,.25)", color: "var(--ink-4)" },
  };
  return <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.5, ...s[kind] }}>{children}</div>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

// ─── GitHub token links ────────────────────────────────────────────────────

/** Classic PAT scopes Dockhand needs: read repos, install push webhooks, see org repos. */
const CLASSIC_SCOPES = "repo,admin:repo_hook,read:org";

/** Base web URL for token pages: github.com, or an Enterprise server URL once it's a valid http(s) URL. */
function githubWebBase(serverUrl?: string): string {
  const s = (serverUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+/.test(s) ? s : "https://github.com";
}

export function githubTokenUrls(serverUrl?: string) {
  const base = githubWebBase(serverUrl);
  return {
    classic: `${base}/settings/tokens/new?description=Dockhand&scopes=${CLASSIC_SCOPES}`,
    fineGrained: `${base}/settings/personal-access-tokens/new`,
  };
}

/** "Generate a token on GitHub ↗" + fine-grained alternative with the permissions it needs. */
export function GithubTokenLinks({ serverUrl, size = 12.5 }: { serverUrl?: string; size?: number }) {
  const u = githubTokenUrls(serverUrl);
  const link: CSSProperties = { fontSize: size, fontWeight: 600, color: "var(--blue)" };
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 4, fontWeight: 400, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
      <span>
        <a href={u.classic} target="_blank" rel="noopener noreferrer" style={link}>Generate a token on GitHub ↗</a>
        <span> — classic token, pre-filled with <code className="mono">repo</code>, <code className="mono">admin:repo_hook</code> and <code className="mono">read:org</code>.</span>
      </span>
      <span>
        Prefer fine-grained?{" "}
        <a href={u.fineGrained} target="_blank" rel="noopener noreferrer" style={{ ...link, fontSize: 12 }}>Create one ↗</a>
        <span> with Contents: read, Metadata: read, Webhooks: read &amp; write, Commit statuses: read.</span>
      </span>
    </span>
  );
}
