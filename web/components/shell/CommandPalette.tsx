"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { post, useApi } from "@/lib/api";
import { avatarBg, containerColor, hostStatusColor, initial } from "@/lib/format";
import type { Container, Host } from "@/lib/types";
import { Icon, type IconName } from "../icons";
import { useShell } from "./context";
import { KeyChip } from "./Shortcuts";

interface Item {
  id: string;
  group: "Navigation" | "Hosts" | "Containers" | "Actions";
  label: string;
  sub?: string;
  keywords?: string;
  icon?: IconName;
  avatar?: { name: string; color: string; dot?: string };
  dot?: string;
  hint?: string[];
  run: () => void;
  /** Only list when the user has typed something. */
  searchOnly?: boolean;
}

const GROUP_ORDER: Item["group"][] = ["Navigation", "Hosts", "Containers", "Actions"];
const GROUP_LIMIT: Record<Item["group"], number> = { Navigation: 8, Hosts: 8, Containers: 8, Actions: 10 };

/** Subsequence match with bonuses for word starts and contiguous runs. -1 = no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1 + (idx === 0 || /[\s\-_/.:@]/.test(t[idx - 1]) ? 200 : 0);
  let s = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    if (found === ti) run++;
    else run = 0;
    s += 10 + run * 5 + (found === 0 || /[\s\-_/.:@]/.test(t[found - 1]) ? 15 : 0) - Math.min(8, found - ti);
    ti = found + 1;
  }
  return s;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const shell = useShell();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  const { data: containers } = useApi<Container[]>("/api/containers");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => router.push(href);
    const hostName = new Map((hosts ?? []).map((h) => [h.id, h.name]));
    const list: Item[] = [
      { id: "nav-fleet", group: "Navigation", label: "Fleet", sub: "All hosts at a glance", icon: "grid", hint: ["G", "F"], run: go("/") },
      { id: "nav-deploy", group: "Navigation", label: "Deploy", sub: "From GitHub or an image", icon: "rocket", hint: ["G", "D"], run: go("/deploy") },
      { id: "nav-uptime", group: "Navigation", label: "Uptime", sub: "Monitors and incidents", icon: "pulse", hint: ["G", "U"], run: go("/uptime") },
      { id: "nav-alerts", group: "Navigation", label: "Alerts", icon: "bell", hint: ["G", "A"], run: go("/alerts") },
      { id: "nav-settings", group: "Navigation", label: "Settings", sub: "Hosts", icon: "settings", hint: ["G", "S"], run: go("/settings/hosts") },
      { id: "nav-github", group: "Navigation", label: "Settings · GitHub", keywords: "git accounts repos", icon: "branch", run: go("/settings/github"), searchOnly: true },
      { id: "nav-mcp", group: "Navigation", label: "Settings · MCP", keywords: "api keys claude ai", icon: "mcp", run: go("/settings/mcp"), searchOnly: true },
      { id: "nav-notif", group: "Navigation", label: "Settings · Notifications", keywords: "channels email slack discord ntfy webhook", icon: "mail", run: go("/settings/notifications"), searchOnly: true },
      { id: "nav-updates", group: "Navigation", label: "Settings · Updates", keywords: "self update version", icon: "update", run: go("/settings/updates"), searchOnly: true },
      { id: "nav-account", group: "Navigation", label: "Settings · Account", keywords: "password profile sessions", icon: "user", run: go("/settings/account"), searchOnly: true },
    ];
    for (const h of hosts ?? []) {
      list.push({ id: `host-${h.id}`, group: "Hosts", label: h.name, sub: `${h.address}${h.os ? ` · ${h.os}` : ""}`, keywords: h.status, avatar: { name: h.name, color: h.color, dot: hostStatusColor(h.status) }, run: go(`/hosts/${h.id}`) });
      if (h.method !== "local") list.push({ id: `ssh-${h.id}`, group: "Hosts", label: `Open SSH on ${h.name}`, sub: `${h.user}@${h.address}`, keywords: "shell terminal ssh console", icon: "terminal", run: () => shell.openTerminal({ kind: "shell", hostId: h.id }), searchOnly: true });
    }
    for (const c of containers ?? []) {
      list.push({
        id: `ctr-${c.hostId}-${c.id}`,
        group: "Containers",
        label: c.name,
        sub: `${hostName.get(c.hostId) ?? "host"} · ${c.image}`,
        keywords: `${c.stack} ${c.service} ${c.shortId}`,
        dot: containerColor(c.state, c.health),
        run: () => shell.openContainer(c.hostId, c.id),
        searchOnly: true,
      });
    }
    for (const c of containers ?? []) {
      const where = hostName.get(c.hostId) ?? "host";
      list.push({ id: `logs-${c.hostId}-${c.id}`, group: "Actions", label: `Logs: ${c.name}`, sub: `docker logs -f · ${where}`, keywords: `tail ${c.stack} ${c.service}`, icon: "logs", run: () => shell.openTerminal({ kind: "logs", hostId: c.hostId, containerId: c.id, name: c.name }), searchOnly: true });
      if (c.state === "running") list.push({ id: `exec-${c.hostId}-${c.id}`, group: "Actions", label: `Shell: ${c.name}`, sub: `docker exec · ${where}`, keywords: `terminal exec sh ${c.stack} ${c.service}`, icon: "terminal", run: () => shell.openTerminal({ kind: "exec", hostId: c.hostId, containerId: c.id, name: c.name }), searchOnly: true });
    }
    list.push(
      { id: "act-host", group: "Actions", label: "Add host", sub: "Connect a machine over SSH", icon: "plus", keywords: "new server", run: () => shell.openDialog({ type: "host" }) },
      { id: "act-git", group: "Actions", label: "Deploy from GitHub", icon: "branch", keywords: "repo compose", run: go("/deploy?mode=git") },
      { id: "act-run", group: "Actions", label: "Run a container", icon: "play", keywords: "image docker run", run: go("/deploy?mode=image") },
      { id: "act-pull", group: "Actions", label: "Pull image", icon: "download", keywords: "docker pull", run: () => shell.openDialog({ type: "pull" }) },
      { id: "act-monitor", group: "Actions", label: "Add monitor", icon: "pulse", keywords: "uptime http tcp check", run: () => shell.openDialog({ type: "monitor" }) },
      { id: "act-theme", group: "Actions", label: "Toggle dark mode", icon: "moon", keywords: "theme light", hint: ["T"], run: () => shell.toggleTheme() },
      { id: "act-keys", group: "Actions", label: "Keyboard shortcuts", icon: "keyboard", hint: ["?"], run: () => shell.openShortcuts() },
      { id: "act-notif", group: "Actions", label: "Notifications", icon: "bell", hint: ["N"], run: () => shell.openNotifications() },
    );
    for (const h of hosts ?? []) {
      list.push({ id: `stack-${h.id}`, group: "Actions", label: `New stack on ${h.name}`, icon: "layers", keywords: "compose", run: () => shell.openDialog({ type: "compose", hostId: h.id }), searchOnly: true });
    }
    list.push({
      id: "act-logout",
      group: "Actions",
      label: "Sign out",
      icon: "logout",
      keywords: "log out logout",
      run: async () => {
        try {
          await post("/api/auth/logout");
        } catch {
          /* ignore */
        }
        window.location.href = "/login";
      },
    });
    return list;
  }, [hosts, containers, router, shell]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const scored = items
      .map((it) => {
        if (!query) return { it, s: it.searchOnly ? -1 : 0 };
        const s = Math.max(score(query, it.label), score(query, `${it.label} ${it.sub ?? ""} ${it.keywords ?? ""}`) * 0.6);
        return { it, s };
      })
      .filter((x) => x.s >= 0 && (query ? x.s > 0 : true));
    const groups: { group: Item["group"]; items: Item[] }[] = [];
    for (const g of GROUP_ORDER) {
      let arr = scored.filter((x) => x.it.group === g);
      if (query) arr = arr.sort((a, b) => b.s - a.s);
      const top = arr.slice(0, GROUP_LIMIT[g]).map((x) => x.it);
      if (top.length) groups.push({ group: g, items: top });
    }
    // When searching, put the group with the best hit first.
    if (query) {
      const best = (g: { items: Item[] }) => Math.max(...g.items.map((it) => scored.find((x) => x.it === it)?.s ?? 0));
      groups.sort((a, b) => best(b) - best(a));
    }
    return groups;
  }, [items, q]);

  const flat = useMemo(() => results.flatMap((g) => g.items), [results]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runItem = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let idx = -1;
  return (
    <div className="dialog-scrim" style={{ placeItems: "start center", paddingTop: "12vh", zIndex: 92 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: "min(640px, 100%)", padding: 0, gap: 0, overflow: "hidden", maxHeight: "72vh", background: "var(--surface)", border: 0, backdropFilter: "none", WebkitBackdropFilter: "none", boxShadow: "0 40px 100px rgba(0,0,0,.35)" }} onKeyDown={onKey}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 14px 0 20px", height: 60, background: "var(--btn)", color: "var(--btn-ink)", flex: "none" }}>
          <span style={{ display: "flex", opacity: 0.7 }}>
            <Icon name="search" size={19} />
          </span>
          <input
            ref={inputRef}
            data-plain
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search hosts, containers, or run a command…"
            style={{ flex: 1, minWidth: 0, height: 58, border: 0, background: "transparent", fontSize: 16, fontWeight: 500, color: "var(--btn-ink)", outline: "none", caretColor: "var(--btn-ink)" }}
          />
          <span className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 7, background: "rgba(127,127,127,.25)", opacity: 0.9, flex: "none" }}>esc</span>
        </div>
        <div ref={listRef} style={{ overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0 }}>
          {flat.length === 0 && (
            <div style={{ padding: "34px 16px", textAlign: "center", fontSize: 13.5, color: "var(--ink-3)" }}>
              No results for “<span style={{ color: "var(--ink)" }}>{q}</span>”
            </div>
          )}
          {results.map((g) => (
            <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="section-label" style={{ padding: "10px 12px 6px" }}>{g.group}</span>
              {g.items.map((it) => {
                idx++;
                const i = idx;
                const on = i === active;
                return (
                  <button
                    key={it.id}
                    data-idx={i}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => runItem(it)}
                    style={{ display: "flex", alignItems: "center", gap: 12, height: 46, padding: "0 10px", border: 0, borderRadius: 12, background: on ? "var(--fill-1)" : "transparent", color: "var(--ink)", cursor: "pointer", textAlign: "left", width: "100%", flex: "none" }}
                  >
                    {it.avatar ? (
                      <span style={{ position: "relative", width: 30, height: 30, flex: "none", borderRadius: 9, background: avatarBg(it.avatar.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 12.5, fontWeight: 700 }}>
                        {initial(it.avatar.name)}
                        {it.avatar.dot && <span style={{ position: "absolute", right: -3, bottom: -3, width: 10, height: 10, borderRadius: "50%", background: it.avatar.dot, border: "2px solid var(--surface)" }} />}
                      </span>
                    ) : (
                      <span style={{ width: 30, height: 30, flex: "none", borderRadius: 10, background: on ? "var(--btn)" : "var(--fill-1)", color: on ? "var(--btn-ink)" : "var(--ink-2)", display: "grid", placeItems: "center", transition: "background .12s" }}>
                        {it.dot ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: it.dot }} /> : <Icon name={it.icon ?? "chevronRight"} size={15} />}
                      </span>
                    )}
                    <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                      <span className={`ellipsis ${it.group === "Containers" ? "mono" : ""}`} style={{ fontSize: it.group === "Containers" ? 13 : 13.5, fontWeight: 600 }}>{it.label}</span>
                      {it.sub && <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: it.group === "Hosts" || it.group === "Containers" ? "var(--mono)" : undefined }}>{it.sub}</span>}
                    </span>
                    {it.hint && (
                      <span style={{ display: "flex", gap: 4, flex: "none" }}>
                        {it.hint.map((k) => (
                          <KeyChip key={k}>{k}</KeyChip>
                        ))}
                      </span>
                    )}
                    {on && !it.hint && <span style={{ display: "flex", color: "var(--ink-3)", flex: "none" }}><Icon name="chevronRight" size={15} /></span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderTop: "1px solid var(--line-1)", fontSize: 11.5, color: "var(--ink-3)", flex: "none", flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyChip>↑</KeyChip>
            <KeyChip>↓</KeyChip>
            navigate
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyChip>↵</KeyChip>
            open
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyChip>esc</KeyChip>
            close
          </span>
          <span style={{ marginLeft: "auto" }}>{flat.length} result{flat.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}
