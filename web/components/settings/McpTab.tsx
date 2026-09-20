"use client";

import { Fragment, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Dialog, DialogHeader, HostChips, Seg, Toggle, copyText } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { del, errMsg, invalidate, patch, useApi } from "@/lib/api";
import { C, ago, clock, dateTime, halo, since } from "@/lib/format";
import type { ApiKey, Host, McpActivity, McpStatus, McpTool, Settings } from "@/lib/types";
import { InkButton, InkHead, InkSeg, Portal, cardStyle, colStack, rowStyle, twoCol, useSettings } from "./common";
import { isToday } from "@/components/alerts/actions";

const GROUPS: McpTool["group"][] = ["Hosts", "Containers", "Stacks", "Images", "Logs", "Deploy"];
const GROUP_STYLE: Record<McpTool["group"], { icon: IconName; color: string }> = {
  Hosts: { icon: "server", color: C.blue },
  Containers: { icon: "box", color: C.ok },
  Stacks: { icon: "layers", color: C.violet },
  Images: { icon: "image", color: "#14b8c4" },
  Logs: { icon: "logs", color: "#5f6675" },
  Deploy: { icon: "rocket", color: C.warn },
};

type ToolState = Settings["mcp"]["tools"];

function toolState(tools: McpTool[], saved: ToolState): ToolState {
  const out: ToolState = {};
  for (const t of tools) out[t.name] = saved[t.name] ?? { enabled: true, confirm: t.writes };
  return out;
}

export function McpTab() {
  const { settings } = useSettings();
  const on = !!settings?.mcp.enabled;
  return (
    <div style={twoCol(380)}>
      <div style={colStack}>
        <ServerCard />
        {on && <ToolsCard />}
      </div>
      {on && (
        <div style={colStack}>
          <KeysCard />
          <ConnectCard />
          <ActivityCard />
        </div>
      )}
    </div>
  );
}

function ServerCard() {
  const shell = useShell();
  const { settings, save } = useSettings();
  const { data: mcp } = useApi<McpStatus>("/api/mcp", { refresh: 30000 });
  const { data: hosts, mutate: mutateHosts } = useApi<Host[]>("/api/hosts");
  const on = !!settings?.mcp.enabled;

  const toggleHost = async (id: string) => {
    const h = hosts?.find((x) => x.id === id);
    if (!h || !hosts) return;
    const v = !h.mcpExposed;
    const prev = hosts;
    mutateHosts(hosts.map((x) => (x.id === id ? { ...x, mcpExposed: v } : x)), { revalidate: false });
    try {
      await patch(`/api/hosts/${id}`, { mcpExposed: v });
      invalidate("/api/hosts");
    } catch (e) {
      mutateHosts(prev, { revalidate: false });
      shell.toast({ kind: "error", title: `Couldn't update ${h.name}`, text: errMsg(e) });
    }
  };

  return (
    <div className="glass-card" style={cardStyle(18)}>
      <InkHead icon="mcp" title="MCP server" sub="Let AI assistants inspect and operate your hosts through Dockhand.">
        <Toggle on={on} disabled={!settings} onChange={(v) => save({ mcp: { enabled: v } })} title={on ? "Turn the MCP server off" : "Turn the MCP server on"} />
      </InkHead>
      {!settings && <span className="skel" style={{ height: 46, borderRadius: 14 }} />}
      {settings && on && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 14, background: "rgba(34,160,107,.08)", border: "1px solid rgba(34,160,107,.25)", fontSize: 13, color: "var(--ok-ink)", flexWrap: "wrap" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.ok, boxShadow: "0 0 0 4px rgba(34,160,107,.18)", flex: "none" }} />
            <span style={{ fontWeight: 600 }}>Listening</span>
            <button
              type="button"
              className="mono ellipsis"
              title="Copy endpoint URL"
              disabled={!mcp}
              onClick={() => mcp && copyText(mcp.url).then(() => shell.toast({ kind: "ok", title: "Endpoint copied", text: mcp.url }))}
              style={{ fontSize: 12, color: "var(--ink-4)", minWidth: 0, flex: "0 1 auto", border: 0, background: "transparent", padding: 0, cursor: "copy", textAlign: "left" }}
            >
              {mcp?.url ?? "…"}
            </button>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{mcp ? `${mcp.callsToday} calls today` : ""}</span>
          </div>
          {mcp?.listenError && (
            <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)", lineHeight: 1.5 }}>
              Couldn&apos;t listen on port {mcp.port}: <span className="mono">{mcp.listenError}</span>. The endpoint is still served on Dockhand&apos;s own port at <span className="mono">/mcp</span>.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
            <div className="field">
              Transport
              <Seg<"http" | "sse"> options={[{ value: "http", label: "Streamable HTTP" }, { value: "sse", label: "SSE" }]} value={settings.mcp.transport} onChange={(v) => save({ mcp: { transport: v } })} style={{ flexWrap: "nowrap" }} />
            </div>
            <PortField port={settings.mcp.port ?? 0} published={mcp?.publishedPort ?? 0} own={ownPort(mcp?.url)} onSave={(port) => save({ mcp: { port } })} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Hosts exposed to MCP</span>
            {hosts ? (
              hosts.length ? (
                <HostChips hosts={hosts} selected={hosts.filter((h) => h.mcpExposed).map((h) => h.id)} onToggle={toggleHost} />
              ) : (
                <span className="field-hint">No hosts yet.</span>
              )
            ) : (
              <span className="skel" style={{ height: 34, width: "60%" }} />
            )}
          </div>
        </>
      )}
      {settings && !on && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
          Off. Turn it on to expose a Model Context Protocol endpoint — Claude, Cursor or any MCP client can then list containers, read logs, restart services and deploy stacks, scoped by the permissions you set below.
        </p>
      )}
    </div>
  );
}

/** Dedicated MCP port. Empty = serve /mcp on Dockhand's own port only. */
/** Port Dockhand itself is reached on, from the MCP URL (valid while no dedicated port is set). */
function ownPort(url?: string): string {
  try {
    const u = new URL(url ?? (typeof window !== "undefined" ? window.location.href : ""));
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function PortField({ port, published, own, onSave }: { port: number; published: number; own: string; onSave: (p: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const value = draft ?? (port ? String(port) : "");
  const commit = async () => {
    if (draft == null) return;
    const t = draft.trim();
    const n = t ? parseInt(t, 10) : 0;
    if (t && !(/^\d+$/.test(t) && n >= 1024 && n <= 65535)) {
      setErr("Use a port between 1024 and 65535, or leave it empty.");
      return;
    }
    setErr("");
    if (n !== port) await onSave(n);
    setDraft(null);
  };
  return (
    <label className="field">
      Port
      <input
        className="input mono"
        inputMode="numeric"
        value={value}
        placeholder={port ? "" : own ? `${own} (Dockhand's)` : "same as Dockhand"}
        onChange={(e) => {
          setDraft(e.target.value.replace(/[^0-9]/g, ""));
          setErr("");
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            setErr("");
          }
        }}
        style={{ fontSize: 13 }}
      />
      {err ? (
        <span className="field-hint" style={{ color: "var(--crit-ink)" }}>{err}</span>
      ) : port && published && port !== published ? (
        <span className="field-hint" style={{ color: "var(--warn-ink)" }}>
          Port {port} isn&apos;t published — set <span className="mono">DOCKHAND_MCP_PORT={port}</span> in .env and run <span className="mono">docker compose up -d</span>, or{" "}
          <button type="button" className="btn-link" onClick={() => onSave(published)}>use {published}</button>.
        </span>
      ) : port ? (
        <span className="field-hint">Served on :{port}/mcp{published === port ? " — published by docker-compose." : "."}</span>
      ) : published ? (
        <span className="field-hint">
          Empty = Dockhand&apos;s own port at /mcp.{" "}
          <button type="button" className="btn-link" onClick={() => onSave(published)}>Use {published}</button> (published by docker-compose).
        </span>
      ) : (
        <span className="field-hint">Empty = Dockhand&apos;s own port at /mcp.</span>
      )}
    </label>
  );
}

function ToolsCard() {
  const { settings, save } = useSettings();
  const { data: mcp } = useApi<McpStatus>("/api/mcp", { refresh: 30000 });
  const tools = useMemo(() => mcp?.tools ?? [], [mcp]);
  const state = useMemo(() => toolState(tools, settings?.mcp.tools ?? {}), [tools, settings]);
  const enabled = tools.filter((t) => state[t.name]?.enabled).length;
  const confirming = tools.filter((t) => t.writes && state[t.name]?.enabled && state[t.name]?.confirm).length;

  const setTool = (name: string, p: Partial<ToolState[string]>) => save({ mcp: { tools: { ...state, [name]: { ...state[name], ...p } } } });
  const preset = (full: boolean) => {
    const next: ToolState = {};
    for (const t of tools) next[t.name] = { enabled: full || !t.writes, confirm: state[t.name]?.confirm ?? t.writes };
    save({ mcp: { tools: next } });
  };

  return (
    <div className="glass-card" style={cardStyle(14)}>
      <InkHead title="Tools" sub={mcp ? `${enabled} of ${tools.length} enabled · ${confirming} need confirmation` : undefined} wrap>
        <InkButton onClick={() => preset(false)} disabled={!tools.length}>Read-only</InkButton>
        <InkButton onClick={() => preset(true)} disabled={!tools.length}>Full control</InkButton>
      </InkHead>
      {!mcp && [0, 1, 2, 3].map((i) => <span key={i} className="skel" style={{ height: 52, borderRadius: 14 }} />)}
      {GROUPS.map((g) => {
        const list = tools.filter((t) => t.group === g);
        if (!list.length) return null;
        const gs = GROUP_STYLE[g];
        return (
          <Fragment key={g}>
            <div className="section-label" style={{ padding: "10px 4px 2px" }}>{g}</div>
            {list.map((t) => {
              const st = state[t.name];
              return (
                <div key={t.name} style={rowStyle(false, { padding: "10px 12px", opacity: st.enabled ? 1 : 0.65 })}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: halo(t.writes ? C.warn : gs.color, 0.12), color: t.writes ? C.warn : gs.color, display: "grid", placeItems: "center", flex: "none" }}>
                    <Icon name={gs.icon} size={15} />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="mono ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</span>
                      {t.writes && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "rgba(224,160,32,.15)", color: "var(--warn-ink)", flex: "none" }}>writes</span>}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t.desc}</span>
                  </span>
                  {t.writes && (
                    <button
                      type="button"
                      title={st.confirm ? "Asks the client to confirm before running" : "Runs without confirmation"}
                      onClick={() => setTool(t.name, { confirm: !st.confirm })}
                      style={{ height: 26, padding: "0 8px", borderRadius: 8, border: `1px solid ${st.confirm ? "rgba(224,160,32,.45)" : "var(--line-2)"}`, background: st.confirm ? "rgba(224,160,32,.1)" : "transparent", fontSize: 11, fontWeight: 600, cursor: "pointer", color: st.confirm ? "var(--warn-ink)" : "var(--ink-3)", whiteSpace: "nowrap", flex: "none" }}
                    >
                      {st.confirm ? "Confirm" : "Auto"}
                    </button>
                  )}
                  <Toggle on={st.enabled} onChange={(v) => setTool(t.name, { enabled: v })} />
                </div>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

const SCOPE_LABEL: Record<ApiKey["scope"], string> = { read: "read-only", full: "full control", custom: "custom" };

function KeysCard() {
  const shell = useShell();
  const { data: keys, mutate } = useApi<ApiKey[]>("/api/mcp/keys");
  const live = (keys ?? []).filter((k) => !k.revoked);

  const revoke = async (k: ApiKey) => {
    const ok = await shell.confirm({ title: `Revoke “${k.name}”?`, text: "Clients using this key lose access immediately. This can't be undone.", confirmLabel: "Revoke key", danger: true, icon: "key", details: [{ k: "Key", v: `${k.prefix}…` }, { k: "Last used", v: k.lastUsedAt ? ago(k.lastUsedAt) : "never" }] });
    if (!ok) return;
    const prev = keys;
    mutate(keys?.filter((x) => x.id !== k.id), { revalidate: false });
    try {
      await del(`/api/mcp/keys/${k.id}`);
      shell.toast({ kind: "ok", title: `Revoked ${k.name}` });
      mutate();
    } catch (e) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: "Couldn't revoke key", text: errMsg(e) });
    }
  };

  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="API keys" sub="one per client">
        <button type="button" className="set-ink-btn solid" onClick={() => shell.openDialog({ type: "apiKey" })}>
          <Icon name="plus" size={14} />
          New key
        </button>
      </InkHead>
      {!keys && [0, 1].map((i) => <span key={i} className="skel" style={{ height: 54, borderRadius: 14 }} />)}
      {keys && !live.length && <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>No keys yet. Create one for each client that should talk to Dockhand.</span>}
      {live.map((k) => {
        const recent = k.lastUsedAt && since(k.lastUsedAt) < 86400;
        const expired = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
        return (
          <div key={k.id} style={rowStyle()}>
            <span className="dot" style={{ background: expired ? C.crit : recent ? C.ok : "var(--muted)" }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>{k.name}</span>
              <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {k.prefix}… · {SCOPE_LABEL[k.scope]} · {expired ? "expired" : k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : "never used"}
              </span>
            </span>
            <button type="button" className="btn2 sm danger" onClick={() => revoke(k)}>Revoke</button>
          </div>
        );
      })}
    </div>
  );
}

type Client = "claude" | "code" | "desktop" | "cursor";

function snippet(c: Client, url: string): { text: string; hint: string } {
  if (c === "claude") {
    return {
      text: url,
      hint: "Claude chat, Cowork and the Claude apps: Settings → Connectors → Add custom connector, paste this URL and click Connect. You'll sign in to Dockhand and choose read-only or full access; no API key needed. Dockhand must be reachable from the internet over https.",
    };
  }
  if (c === "desktop") {
    return {
      text: JSON.stringify(
        { mcpServers: { dockhand: { command: "npx", args: ["mcp-remote", url, "--header", "Authorization: Bearer ${DOCKHAND_KEY}"], env: { DOCKHAND_KEY: "dh_…" } } } },
        null,
        2,
      ),
      hint: "Add to claude_desktop_config.json (Settings → Developer → Edit config), paste an API key into DOCKHAND_KEY and restart Claude Desktop.",
    };
  }
  if (c === "code") {
    return {
      text: `claude mcp add --transport http dockhand ${url}`,
      hint: "Run in your terminal, then /mcp in Claude Code to sign in to Dockhand (add --scope user to use it in every project). Or skip the sign-in with an API key: append --header \"Authorization: Bearer <key>\".",
    };
  }
  return {
    text: JSON.stringify({ mcpServers: { dockhand: { url, headers: { Authorization: "Bearer dh_…" } } } }, null, 2),
    hint: "Save as .cursor/mcp.json in your project (or ~/.cursor/mcp.json for all projects) and replace dh_… with an API key.",
  };
}

function ConnectCard() {
  const shell = useShell();
  const { data: mcp } = useApi<McpStatus>("/api/mcp", { refresh: 30000 });
  const [client, setClient] = useState<Client>("claude");
  const url = mcp?.url || (typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp");
  const s = snippet(client, url);
  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Connect a client" wrap>
        <InkSeg<Client> options={[{ value: "claude", label: "Claude & Cowork" }, { value: "code", label: "Claude Code" }, { value: "desktop", label: "Desktop config" }, { value: "cursor", label: "Cursor" }]} value={client} onChange={setClient} />
      </InkHead>
      <div style={{ position: "relative" }}>
        <code className="term-block" style={{ display: "block", paddingRight: 70 }}>{s.text}</code>
        <button
          type="button"
          onClick={() => copyText(s.text).then(() => shell.toast({ kind: "ok", title: "Config copied" }))}
          style={{ position: "absolute", top: 10, right: 10, height: 26, padding: "0 10px", borderRadius: 8, border: 0, background: "rgba(255,255,255,.12)", color: "#fff", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
        >
          Copy
        </button>
      </div>
      <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>{s.hint}</span>
    </div>
  );
}

function ActivityRow({ a }: { a: McpActivity }) {
  return (
    <div style={{ position: "relative", fontSize: 12.5, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ position: "absolute", left: -20, top: 5, width: 7, height: 7, borderRadius: "50%", background: a.ok ? C.ok : C.crit }} />
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", flex: "none" }} title={new Date(a.at).toLocaleString()}>{isToday(a.at) ? clock(a.at, false) : dateTime(a.at)}</span>
      <span style={{ fontWeight: 600 }}>{a.client}</span>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{a.tool}</span>
      {a.detail && <span style={{ color: a.ok ? "var(--ink-3)" : "var(--crit-ink)", wordBreak: "break-word" }}>{a.detail}</span>}
    </div>
  );
}

function ActivityCard() {
  const [full, setFull] = useState(false);
  const { data } = useApi<McpActivity[]>("/api/mcp/activity?limit=8", { refresh: 30000 });
  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Recent activity">
        <InkButton onClick={() => setFull(true)}>Full log</InkButton>
      </InkHead>
      {!data && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 14, width: `${80 - i * 15}%` }} />)}
      {data && !data.length && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No MCP calls yet.</span>}
      {!!data?.length && (
        <div style={{ borderLeft: "1px solid var(--line-2)", paddingLeft: 16, marginLeft: 4, display: "flex", flexDirection: "column", gap: 12 }}>
          {data.map((a) => <ActivityRow key={a.id} a={a} />)}
        </div>
      )}
      {full && <FullLogDialog onClose={() => setFull(false)} />}
    </div>
  );
}

type LogFilter = "all" | "errors" | "writes";

/** Last 200 MCP calls with a text filter (design "Full log"). */
function FullLogDialog({ onClose }: { onClose: () => void }) {
  const { data, isValidating, mutate } = useApi<McpActivity[]>("/api/mcp/activity?limit=200", { refresh: 15000 });
  const { data: mcp } = useApi<McpStatus>("/api/mcp");
  const [q, setQ] = useState("");
  const [f, setF] = useState<LogFilter>("all");
  const writes = useMemo(() => new Set((mcp?.tools ?? []).filter((t) => t.writes).map((t) => t.name)), [mcp]);
  const needle = q.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (a) => (f === "all" || (f === "errors" ? !a.ok : writes.has(a.tool))) && (!needle || `${a.client} ${a.tool} ${a.detail}`.toLowerCase().includes(needle)),
  );
  const failed = (data ?? []).filter((a) => !a.ok).length;
  return (
    <Portal>
      <Dialog onClose={onClose} width={640} label="MCP activity log">
        <DialogHeader icon="mcp" title="MCP activity" sub={data ? `Last ${data.length} calls · ${failed} failed` : "Loading…"} onClose={onClose} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="input-wrap" style={{ flex: "1 1 220px" }}>
            <span className="input-icon"><Icon name="search" size={15} /></span>
            <input className="input with-icon" autoFocus placeholder="Filter by client, tool or detail" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
          <Seg<LogFilter> options={[{ value: "all", label: "All" }, { value: "errors", label: "Errors" }, { value: "writes", label: "Writes" }]} value={f} onChange={setF} />
        </div>
        <div style={{ maxHeight: "min(56vh, 520px)", overflow: "auto", padding: "4px 4px 4px 0" }}>
          {!data && [0, 1, 2, 3, 4].map((i) => <span key={i} className="skel" style={{ display: "block", height: 14, width: `${85 - i * 10}%`, marginBottom: 12 }} />)}
          {data && !rows.length && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>{data.length ? "Nothing matches this filter." : "No MCP calls yet."}</span>}
          {!!rows.length && (
            <div style={{ borderLeft: "1px solid var(--line-2)", paddingLeft: 16, marginLeft: 8, display: "flex", flexDirection: "column", gap: 12 }}>
              {rows.map((a) => <ActivityRow key={a.id} a={a} />)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)", marginRight: "auto" }}>Kept for 90 days.</span>
          <button type="button" className="btn2 lg" onClick={() => mutate()} disabled={isValidating}>
            {isValidating ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="restart" size={14} />}
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
      </Dialog>
    </Portal>
  );
}
