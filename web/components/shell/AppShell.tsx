"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon, Logo, type IconName } from "../icons";
import { ShellContext, useShell, type ConfirmInput, type DialogState, type Shell, type TerminalTarget, type ToastInput } from "./context";
import { patch, useApi } from "@/lib/api";
import { applyTheme, isDark, storedTheme } from "@/lib/theme";
import { avatarBg, hostStatusColor, initial } from "@/lib/format";
import type { Host, Overview, Theme, User } from "@/lib/types";
import { ContainerSidecar } from "../sidecar/ContainerSidecar";
import { useOutside } from "../ui";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsDialog, useGlobalShortcuts } from "./Shortcuts";
import { NotificationsDrawer } from "./NotificationsDrawer";
import { TerminalWindow } from "./TerminalWindow";
import { Dialogs } from "../dialogs";

export function useIsMobile(bp = 720) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia(`(max-width: ${bp}px)`);
    const f = () => setM(q.matches);
    f();
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [bp]);
  return m;
}

interface ToastItem extends ToastInput {
  id: number;
}

export function AppShell({ user: initialUser, children }: { user: User; children: ReactNode }) {
  const [user, setUser] = useState(initialUser);
  const [theme, setThemeState] = useState<Theme>(initialUser.theme ?? "system");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmInput & { resolve: (v: boolean) => void }) | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [side, setSide] = useState<{ hostId: string; containerId: string; tab?: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [termReqs, setTermReqs] = useState<{ target: TerminalTarget; seq: number }[]>([]);
  const termSeq = useRef(0);
  const toastId = useRef(0);

  // The server's saved theme wins over localStorage on first load.
  useEffect(() => {
    const t = initialUser.theme ?? storedTheme();
    setThemeState(t);
    applyTheme(t);
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => storedTheme() === "system" && applyTheme("system");
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [initialUser.theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    patch<User>("/api/account", { theme: t }).then(setUser).catch(() => {});
  }, []);

  const toast = useCallback((t: ToastInput) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    const timeout = t.timeout ?? (t.kind === "error" ? 7000 : 4500);
    if (timeout > 0) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), timeout);
  }, []);

  const confirm = useCallback((c: ConfirmInput) => new Promise<boolean>((resolve) => setConfirmState({ ...c, resolve })), []);

  const shell: Shell = useMemo(
    () => ({
      user,
      setUser,
      toast,
      confirm,
      openDialog: setDialog,
      closeDialog: () => setDialog(null),
      openContainer: (hostId, containerId, tab) => setSide({ hostId, containerId, tab }),
      closeContainer: () => setSide(null),
      openTerminal: (target) => setTermReqs((r) => [...r, { target, seq: ++termSeq.current }]),
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setKeysOpen(true),
      openNotifications: () => setNotifOpen(true),
      theme,
      setTheme,
      toggleTheme: () => setTheme(isDark(theme) ? "light" : "dark"),
    }),
    [user, toast, confirm, theme, setTheme],
  );

  useGlobalShortcuts(shell, { paletteOpen, setPaletteOpen, keysOpen, setKeysOpen, blocked: !!dialog || !!confirmState });

  const mobile = useIsMobile();

  return (
    <ShellContext.Provider value={shell}>
      <div style={{ minHeight: "100vh", width: "100%", position: "relative" }}>
        <Dock mobile={mobile} />
        <CommandBar mobile={mobile} />
        <main style={{ padding: mobile ? "80px 16px 112px" : "92px 32px 64px 104px", maxWidth: 1360, minHeight: "100vh" }}>{children}</main>

        {side && <ContainerSidecar hostId={side.hostId} containerId={side.containerId} initialTab={side.tab} onClose={() => setSide(null)} />}
        {termReqs.length > 0 && <TerminalWindow requests={termReqs} onClose={() => setTermReqs([])} />}
        {notifOpen && <NotificationsDrawer onClose={() => setNotifOpen(false)} />}
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
        {keysOpen && <ShortcutsDialog onClose={() => setKeysOpen(false)} />}
        {dialog && <Dialogs state={dialog} onClose={() => setDialog(null)} />}
        {confirmState && (
          <ConfirmDialog
            {...confirmState}
            onClose={(v) => {
              confirmState.resolve(v);
              setConfirmState(null);
            }}
          />
        )}
        <Toasts toasts={toasts} dismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} bottom={mobile ? 96 : 16} />
      </div>
    </ShellContext.Provider>
  );
}

// ─── Spine nav (v2) ────────────────────────────────────────────────────────

const MAIN: { href: string; label: string; icon: IconName; kbd: string; match: (p: string) => boolean }[] = [
  { href: "/", label: "Fleet", icon: "grid", kbd: "G F", match: (p) => p === "/" || p.startsWith("/hosts") },
  { href: "/deploy", label: "Deploy", icon: "rocket", kbd: "G D", match: (p) => p.startsWith("/deploy") },
  { href: "/uptime", label: "Uptime", icon: "pulse", kbd: "G U", match: (p) => p.startsWith("/uptime") },
  { href: "/alerts", label: "Notifications", icon: "bell", kbd: "N", match: (p) => p.startsWith("/alerts") },
  { href: "/settings/hosts", label: "Settings", icon: "settings", kbd: "G S", match: (p) => p.startsWith("/settings") },
];

interface Fly {
  top: number;
  label: string;
  sub?: string;
  kbd?: string;
  dot?: string;
}

const SPINE_ITEM = 48;
const SPINE_GAP = 4;

function Dock({ mobile }: { mobile: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { openDialog, openNotifications } = useShell();
  const { data: hosts } = useApi<Host[]>("/api/hosts", { refresh: 10000 });
  const { data: overview } = useApi<Overview>("/api/overview", { refresh: 15000 });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverHost, setHoverHost] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [fly, setFly] = useState<Fly | null>(null);
  const [createAt, setCreateAt] = useState<DOMRect | null>(null);
  const list = hosts ?? [];
  const openCreate = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFly(null);
    setCreateAt((cur) => (cur ? null : r));
  };
  const createMenu = createAt && <CreateMenu anchor={createAt} mobile={mobile} hosts={list} onClose={() => setCreateAt(null)} />;
  const activeIdx = MAIN.findIndex((d) => d.match(pathname));
  const indIdx = hoverIdx ?? activeIdx;
  const unread = overview?.unreadAlerts ?? 0;

  const showFly = (e: React.MouseEvent, f: Omit<Fly, "top">, mainIdx: number | null = null) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFly({ ...f, top: r.top + r.height / 2 });
    // Hovering anything other than a main item sends the indicator back to the active page.
    setHoverIdx(mainIdx);
    if (mainIdx != null) setHoverHost(null);
  };
  const leave = () => {
    setHoverIdx(null);
    setHoverHost(null);
    setFly(null);
  };

  const hostSub = (h: Host) => (h.status === "offline" ? "offline" : `${h.running} running · ${Math.round(h.cpu)}% cpu`);

  if (mobile) {
    return (
      <nav style={{ position: "fixed", left: "50%", bottom: 12, transform: "translateX(-50%)", zIndex: 50, maxWidth: "calc(100vw - 24px)", borderRadius: 26, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 24px 60px rgba(10,14,24,.35), inset 0 1px 0 rgba(255,255,255,.12)", padding: 5, display: "flex", gap: 2, overflowX: "auto" }}>
        {MAIN.map((d, i) => (
          <button key={d.href} onClick={() => (d.href === "/alerts" ? openNotifications() : router.push(d.href))} title={d.label} style={{ position: "relative", width: 44, height: 44, border: 0, borderRadius: 16, flex: "none", background: i === activeIdx ? "var(--btn-ink)" : "transparent", color: i === activeIdx ? "var(--btn)" : "var(--btn-ink)", display: "grid", placeItems: "center", cursor: "pointer" }}>
            <Icon name={d.icon} size={18} />
            {d.href === "/alerts" && unread > 0 && <span style={{ position: "absolute", right: 4, top: 4, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#e2504c", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center", border: "2px solid var(--btn)", animation: "badgePop .5s cubic-bezier(.34,1.56,.64,1) both" }}>{unread > 99 ? "99+" : unread}</span>}
          </button>
        ))}
        <span style={{ width: 1, height: 26, alignSelf: "center", background: "rgba(127,127,127,.35)", margin: "0 4px", flex: "none" }} />
        {list.map((h) => (
          <button key={h.id} onClick={() => router.push(`/hosts/${h.id}`)} title={h.name} style={{ width: 40, height: 44, border: 0, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer", flex: "none" }}>
            <HostAvatar h={h} glow={pathname === `/hosts/${h.id}`} />
          </button>
        ))}
        <button onClick={openCreate} title="Add or deploy" aria-label="Add or deploy" aria-haspopup="menu" aria-expanded={!!createAt} style={{ width: 44, height: 44, border: 0, borderRadius: 16, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer", color: "var(--btn-ink)", opacity: 0.6, flex: "none" }}>
          <span style={{ width: 28, height: 28, borderRadius: 9, border: "1.5px dashed currentColor", display: "grid", placeItems: "center" }}>
            <Icon name="plus" size={14} />
          </span>
        </button>
        {createMenu}
      </nav>
    );
  }

  const stack = list.slice(0, 3);
  return (
    <>
      <nav onMouseLeave={leave} style={{ position: "fixed", left: 14, top: "50%", transform: "translateY(-50%)", zIndex: 50, width: 58, maxHeight: "calc(100vh - 28px)", borderRadius: 30, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 24px 60px rgba(10,14,24,.35), inset 0 1px 0 rgba(255,255,255,.12)", padding: "10px 0 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <button onClick={() => router.push("/")} title="Dockhand" className="spine-btn" style={{ width: 42, height: 42, border: 0, borderRadius: 15, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer", color: "var(--btn-ink)", flex: "none", marginBottom: 4 }}>
          <Logo size={24} color="currentColor" />
        </button>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: SPINE_GAP, flex: "none" }}>
          <span style={{ position: "absolute", left: 0, top: Math.max(0, indIdx) * (SPINE_ITEM + SPINE_GAP), width: SPINE_ITEM, height: SPINE_ITEM, borderRadius: 17, background: "var(--btn-ink)", opacity: indIdx >= 0 ? (hoverIdx != null && hoverIdx !== activeIdx ? 0.85 : 1) : 0, transition: "top .45s cubic-bezier(.34,1.45,.44,1), opacity .2s", pointerEvents: "none" }} />
          {MAIN.map((d, i) => {
            const on = i === indIdx;
            const bell = d.href === "/alerts" && unread > 0;
            return (
              <button
                key={d.href}
                onClick={() => (d.href === "/alerts" ? openNotifications() : router.push(d.href))}
                onMouseEnter={(e) => showFly(e, { label: d.label, kbd: d.kbd, sub: bell ? `${unread} unread` : undefined }, i)}
                aria-label={d.label}
                style={{ position: "relative", zIndex: 1, width: SPINE_ITEM, height: SPINE_ITEM, border: 0, borderRadius: 17, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer", color: on ? "var(--btn)" : "var(--btn-ink)", flex: "none", padding: 0, transform: `scale(${hoverIdx === i ? 1.08 : 1})`, transition: "transform .22s cubic-bezier(.2,.8,.2,1), color .25s", opacity: on ? 1 : 0.72 }}
              >
                <span style={{ display: "grid", placeItems: "center", animation: bell ? "ring 1.4s ease-in-out 1s 2" : undefined }}>
                  <Icon name={d.icon} size={19} />
                </span>
                {bell && <span style={{ position: "absolute", right: 6, top: 6, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#e2504c", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center", border: "2px solid var(--btn)", animation: "badgePop .5s cubic-bezier(.34,1.56,.64,1) both" }}>{unread > 99 ? "99+" : unread}</span>}
              </button>
            );
          })}
        </div>
        <span style={{ width: 22, height: 1, background: "rgba(127,127,127,.35)", margin: "6px 0", flex: "none" }} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minHeight: 0, width: "100%" }}>
          {!expanded ? (
            list.length > 0 && (
              <button
                onClick={() => setExpanded(true)}
                onMouseEnter={(e) => showFly(e, { label: "Hosts", sub: `${list.filter((h) => h.status === "online").length} of ${list.length} online` })}
                title="Hosts"
                className="spine-btn"
                style={{ position: "relative", width: 48, height: 64, border: 0, borderRadius: 17, background: "transparent", cursor: "pointer", flex: "none", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start" }}
              >
                <span style={{ position: "relative", width: 32, height: 40, flex: "none", marginTop: 4 }}>
                  {stack.map((h, i) => {
                    const size = 26 - i * 2;
                    return (
                      <span key={h.id} style={{ position: "absolute", left: (32 - size) / 2 + (i === 1 ? -5 : i === 2 ? 5 : 0), top: i * 7, width: size, height: size, borderRadius: 9, background: avatarBg(h.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, border: "2px solid var(--btn)", boxShadow: "0 4px 10px rgba(0,0,0,.25)", zIndex: 3 - i, opacity: 1 - i * 0.18 }}>
                        {initial(h.name)}
                      </span>
                    );
                  })}
                </span>
                <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--btn-ink)", opacity: 0.7, lineHeight: 1, marginTop: 2 }}>{list.length} {list.length === 1 ? "host" : "hosts"}</span>
              </button>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, overflow: "auto", width: "100%", padding: "2px 0", maxHeight: "100%" }}>
              {list.map((h, i) => (
                <button
                  key={h.id}
                  onClick={() => router.push(`/hosts/${h.id}`)}
                  onMouseEnter={(e) => {
                    showFly(e, { label: h.name, sub: hostSub(h), dot: hostStatusColor(h.status) });
                    setHoverHost(h.id);
                  }}
                  aria-label={h.name}
                  style={{ position: "relative", width: 48, height: 40, border: 0, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer", flex: "none", animation: "fanIn .4s cubic-bezier(.34,1.45,.44,1) both", animationDelay: `${i * 40}ms`, transform: `scale(${hoverHost === h.id ? 1.12 : 1})`, transition: "transform .22s cubic-bezier(.2,.8,.2,1)" }}
                >
                  <HostAvatar h={h} glow={pathname === `/hosts/${h.id}`} />
                </button>
              ))}
              <button onClick={() => setExpanded(false)} onMouseEnter={leave} title="Collapse" className="spine-dim" style={{ width: 48, height: 28, border: 0, background: "transparent", cursor: "pointer", color: "var(--btn-ink)", opacity: 0.55, display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name="chevron" size={16} style={{ transform: "rotate(180deg)" }} />
              </button>
            </div>
          )}
        </div>
        <button
          onClick={openCreate}
          onMouseEnter={(e) => !createAt && showFly(e, { label: "Add or deploy", sub: "host · container · stack" })}
          aria-label="Add or deploy"
          aria-haspopup="menu"
          aria-expanded={!!createAt}
          className="spine-add"
          style={{ width: 48, height: 44, border: 0, borderRadius: 15, background: createAt ? "rgba(127,127,127,.22)" : "transparent", display: "grid", placeItems: "center", cursor: "pointer", color: "var(--btn-ink)", opacity: createAt ? 1 : 0.6, flex: "none", marginTop: 4 }}
        >
          <span style={{ width: 28, height: 28, borderRadius: 9, border: "1.5px dashed currentColor", display: "grid", placeItems: "center" }}>
            <Icon name="plus" size={14} />
          </span>
        </button>
        <style>{`.spine-btn:hover{background:rgba(127,127,127,.18)!important}.spine-dim:hover{opacity:1!important}.spine-add:hover{opacity:1!important;background:rgba(127,127,127,.18)!important}`}</style>
      </nav>
      {createMenu}
      {fly && (
        <div style={{ position: "fixed", left: 82, top: fly.top, transform: "translateY(-50%)", zIndex: 51, pointerEvents: "none", display: "flex", alignItems: "center", gap: 10, height: 40, padding: "0 14px 0 12px", borderRadius: 14, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 14px 40px rgba(10,14,24,.3)", whiteSpace: "nowrap", animation: "flyIn .25s cubic-bezier(.34,1.5,.44,1) both", transition: "top .28s cubic-bezier(.34,1.4,.44,1)" }}>
          <span style={{ position: "absolute", left: -5, top: "50%", width: 10, height: 10, background: "var(--btn)", transform: "translateY(-50%) rotate(45deg)", borderRadius: 2 }} />
          {fly.dot && <span style={{ width: 8, height: 8, borderRadius: "50%", background: fly.dot }} />}
          <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{fly.label}</span>
            {fly.sub && <span className="mono" style={{ fontSize: 10.5, opacity: 0.65 }}>{fly.sub}</span>}
          </span>
          {fly.kbd && <span className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 6, background: "rgba(127,127,127,.25)" }}>{fly.kbd}</span>}
        </div>
      )}
    </>
  );
}

// ─── "+" create menu ──────────────────────────────────────────────────────

/** The spine's "+": add a host, or deploy a container / GitHub repo / compose stack. */
function CreateMenu({ anchor, mobile, hosts, onClose }: { anchor: DOMRect; mobile: boolean; hosts: Host[]; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { openDialog } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose);
  // On a host page, deploy targets that host; otherwise the deploy page picks one.
  const hostId = pathname.match(/^\/hosts\/([^/?#]+)/)?.[1];
  const host = hosts.find((h) => h.id === hostId);
  const q = host ? `&host=${host.id}` : "";
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  const noHosts = hosts.length === 0;
  const items: { icon: IconName; label: string; sub: string; run: () => void; disabled?: boolean }[] = [
    { icon: "box", label: "Run a container", sub: host ? `From an image, on ${host.name}` : "From Docker Hub, GHCR or any registry", run: () => go(`/deploy?mode=image${q}`), disabled: noHosts },
    { icon: "branch", label: "Deploy from GitHub", sub: "A repo with a compose file", run: () => go(`/deploy?mode=git${q}`), disabled: noHosts },
    { icon: "layers", label: "New compose stack", sub: "Write or paste a docker-compose.yml", run: () => go(`/deploy?mode=compose${q}`), disabled: noHosts },
  ];
  const pos: React.CSSProperties = mobile
    ? { left: Math.max(12, Math.min(anchor.left + anchor.width / 2 - 150, window.innerWidth - 312)), bottom: window.innerHeight - anchor.top + 10 }
    : { left: 82, bottom: Math.max(12, window.innerHeight - anchor.bottom) };
  return (
    <div ref={ref} role="menu" aria-label="Add or deploy" style={{ position: "fixed", ...pos, zIndex: 60, width: 300, padding: 6, borderRadius: 18, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 24px 60px rgba(10,14,24,.4), inset 0 1px 0 rgba(255,255,255,.1)", display: "flex", flexDirection: "column", gap: 2, animation: "pop .18s cubic-bezier(.2,.8,.2,1) both" }}>
      <div style={{ padding: "8px 10px 6px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.55 }}>
        Deploy{host ? ` to ${host.name}` : ""}
      </div>
      {items.map((it) => (
        <MenuRow key={it.label} {...it} />
      ))}
      <span style={{ height: 1, background: "rgba(127,127,127,.3)", margin: "4px 8px" }} />
      <MenuRow icon="server" label="Add host" sub="Connect a machine running Docker" run={() => { onClose(); openDialog({ type: "host" }); }} />
      <MenuRow icon="globe" label="Custom SSH" sub="Open a terminal to any address" run={() => { onClose(); openDialog({ type: "customSsh" }); }} />
      {noHosts && <div style={{ padding: "4px 10px 8px", fontSize: 11.5, opacity: 0.6 }}>Add a host first to deploy containers.</div>}
      <style>{`.cm-row:hover:not(:disabled){background:rgba(127,127,127,.2)}`}</style>
    </div>
  );
}

function MenuRow({ icon, label, sub, run, disabled }: { icon: IconName; label: string; sub: string; run: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className="cm-row" disabled={disabled} onClick={run} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 10px", border: 0, borderRadius: 12, background: "transparent", color: "inherit", cursor: disabled ? "default" : "pointer", textAlign: "left", width: "100%", opacity: disabled ? 0.45 : 1 }}>
      <span style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(127,127,127,.22)", display: "grid", placeItems: "center", flex: "none" }}>
        <Icon name={icon} size={16} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</span>
        <span className="ellipsis" style={{ fontSize: 11.5, opacity: 0.6 }}>{sub}</span>
      </span>
    </button>
  );
}

function HostAvatar({ h, glow }: { h: Host; glow?: boolean }) {
  const dot = hostStatusColor(h.status);
  return (
    <span style={{ position: "relative", width: 30, height: 30, borderRadius: 10, background: avatarBg(h.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, boxShadow: glow ? "0 0 0 2px var(--btn), 0 0 0 4px var(--btn-ink)" : "none", transition: "box-shadow .25s" }}>
      {initial(h.name)}
      <span style={{ position: "absolute", right: -4, bottom: -4, width: 11, height: 11, borderRadius: "50%", background: dot, border: "2px solid var(--btn)", animation: h.status === "online" ? "livePulse 2.4s ease-out infinite" : h.status === "offline" ? "downPulse 1.6s ease-in-out infinite" : undefined }} />
    </span>
  );
}

// ─── Command bar ───────────────────────────────────────────────────────────

function CommandBar({ mobile }: { mobile: boolean }) {
  const { openPalette, openShortcuts, toggleTheme, theme } = useShell();
  const dark = typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : theme === "dark";
  // "⌘K" on Apple platforms, "Ctrl K" elsewhere (same as the shortcuts dialog). Set after mount to keep SSR stable.
  const [modKey, setModKey] = useState("⌘K");
  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setModKey("Ctrl K");
  }, []);
  return (
    <div
      onClick={openPalette}
      role="button"
      aria-label="Search or run a command"
      style={{ cursor: "pointer", position: "fixed", top: 18, left: "50%", transform: "translateX(-50%)", zIndex: 40, width: mobile ? "calc(100vw - 32px)" : "min(560px, calc(100vw - 200px))", height: 46, borderRadius: 23, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 18px 50px rgba(10,14,24,.3), inset 0 1px 0 rgba(255,255,255,.12)", display: "flex", alignItems: "center", gap: 12, padding: "0 8px 0 18px", fontSize: 13.5 }}
    >
      <span style={{ display: "flex", opacity: 0.7 }}><Icon name="search" size={16} /></span>
      <span className="ellipsis" style={{ flex: 1, opacity: 0.7, fontWeight: 500 }}>Search or run a command</span>
      {!mobile && <span className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 7, background: "rgba(127,127,127,.25)", opacity: 0.9 }}>{modKey}</span>}
      <span style={{ width: 1, height: 20, background: "rgba(127,127,127,.35)", margin: "0 2px" }} />
      {!mobile && (
        <button onClick={(e) => { e.stopPropagation(); openShortcuts(); }} title="Keyboard shortcuts" className="cmd-btn mono" style={{ fontSize: 13, fontWeight: 600 }}>
          ?
        </button>
      )}
      <button onClick={(e) => { e.stopPropagation(); toggleTheme(); }} title="Toggle dark mode" className="cmd-btn">
        <Icon name={dark ? "sun" : "moon"} size={15} />
      </button>
      <style>{`.cmd-btn{width:32px;height:32px;border-radius:12px;border:0;background:transparent;color:var(--btn-ink);opacity:.7;display:grid;place-items:center;cursor:pointer;flex:none}.cmd-btn:hover{background:rgba(127,127,127,.22);opacity:1}`}</style>
    </div>
  );
}

// ─── Toasts ────────────────────────────────────────────────────────────────

// v2 design: toasts sit on the dark ink band (var(--btn)), like the dock and command bar.
// The tinted icon tiles are a touch stronger than on a light card so they read on both inks.
const TOAST_STYLE: Record<string, { bg: string; icon: IconName; color: string }> = {
  ok: { bg: "rgba(34,160,107,.22)", icon: "check", color: "#22a06b" },
  error: { bg: "rgba(226,80,76,.22)", icon: "alert", color: "#e2504c" },
  warn: { bg: "rgba(224,160,32,.24)", icon: "alert", color: "#e0a020" },
  info: { bg: "rgba(47,111,237,.22)", icon: "bell", color: "#2f6fed" },
};

function Toasts({ toasts, dismiss, bottom }: { toasts: ToastItem[]; dismiss: (id: number) => void; bottom: number }) {
  return (
    <div role="status" aria-live="polite" style={{ position: "fixed", right: 16, bottom, zIndex: 95, display: "flex", flexDirection: "column", gap: 10, width: "min(360px, calc(100vw - 32px))", pointerEvents: "none" }}>
      {toasts.map((t) => {
        const s = TOAST_STYLE[t.kind ?? "ok"];
        return (
          <div key={t.id} style={{ pointerEvents: "auto", display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 12px 12px 14px", borderRadius: 16, background: "var(--btn)", boxShadow: "0 18px 50px rgba(0,0,0,.3)", animation: "rise .3s cubic-bezier(.2,.8,.2,1) both", color: "var(--btn-ink)" }}>
            <span style={{ width: 28, height: 28, borderRadius: 9, background: s.bg, color: s.color, display: "grid", placeItems: "center", flex: "none", marginTop: 1 }}>
              <Icon name={s.icon} size={15} strokeWidth={2.2} />
            </span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, paddingTop: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>{t.title}</span>
              {t.text && <span style={{ fontSize: 12.5, opacity: 0.7, lineHeight: 1.45, wordBreak: "break-word" }}>{t.text}</span>}
            </span>
            {t.action && (
              // On the ink band the action inverts (as "Open inbox" / "Open SSH" do) so it stays visible.
              <button onClick={() => { t.onAction?.(); dismiss(t.id); }} style={{ height: 30, padding: "0 10px", borderRadius: 9, border: 0, background: "var(--btn-ink)", color: "var(--btn)", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", marginTop: 2 }}>
                {t.action}
              </button>
            )}
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="toast-x" style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: "var(--btn-ink)", opacity: 0.6, cursor: "pointer", fontSize: 13, flex: "none", marginTop: 2 }}>
              ✕
            </button>
          </div>
        );
      })}
      <style>{`.toast-x:hover{background:rgba(127,127,127,.25)!important;opacity:1!important}`}</style>
    </div>
  );
}

// ─── Confirm dialog ────────────────────────────────────────────────────────

function ConfirmDialog({ title, text, confirmLabel, danger, icon, details, typeToConfirm, onClose }: ConfirmInput & { onClose: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = !typeToConfirm || typed === typeToConfirm;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="dialog" style={{ width: "min(440px, 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "-26px -26px 4px", padding: "18px 26px", borderRadius: "24px 24px 0 0", background: "var(--btn)", color: "var(--btn-ink)" }}>
          <span style={{ width: 44, height: 44, borderRadius: 13, background: danger ? "rgba(226,80,76,.22)" : "rgba(127,127,127,.22)", color: danger ? "#ff7b76" : "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name={icon ?? (danger ? "alert" : "restart")} size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <h2 className="dialog-title">{title}</h2>
          </div>
          <button onClick={() => onClose(false)} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 9, border: 0, background: "rgba(127,127,127,.25)", color: "var(--btn-ink)", cursor: "pointer", display: "grid", placeItems: "center" }}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>{text}</p>
        {details && details.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {details.map((d) => (
              <div key={d.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "8px 12px", borderRadius: 10, background: "var(--fill-1)" }}>
                <span style={{ color: "var(--ink-2)" }}>{d.k}</span>
                <span className="mono ellipsis" style={{ fontSize: 12 }}>{d.v}</span>
              </div>
            ))}
          </div>
        )}
        {typeToConfirm && (
          <label className="field">
            <span>
              Type <span className="mono" style={{ color: "var(--ink)" }}>{typeToConfirm}</span> to confirm
            </span>
            <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} />
          </label>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="btn2 lg" onClick={() => onClose(false)}>Cancel</button>
          <button
            className={`btn ${danger ? "danger" : ""}`}
            disabled={!ok || busy}
            autoFocus={!typeToConfirm}
            onClick={() => {
              setBusy(true);
              onClose(true);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
