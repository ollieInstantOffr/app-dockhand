"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Shell } from "./context";
import { Dialog, DialogHeader } from "../ui";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "General",
    items: [
      { keys: ["mod", "K"], label: "Search or run a command" },
      { keys: ["/"], label: "Open search" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["N"], label: "Notifications" },
      { keys: ["T"], label: "Toggle dark mode" },
      { keys: ["Esc"], label: "Close panel or dialog" },
    ],
  },
  {
    title: "Go to",
    items: [
      { keys: ["G", "F"], label: "Fleet" },
      { keys: ["G", "D"], label: "Deploy" },
      { keys: ["G", "R"], label: "All resources" },
      { keys: ["G", "M"], label: "Machines" },
      { keys: ["G", "U"], label: "Uptime" },
      { keys: ["G", "A"], label: "Alerts" },
      { keys: ["G", "S"], label: "Settings" },
    ],
  },
  {
    title: "Terminal window",
    items: [
      { keys: ["mod", "K"], label: "Open SSH / logs from search" },
      { keys: ["Esc"], label: "Close (outside a shell)" },
      { keys: ["2×", "title bar"], label: "Maximise / restore" },
      { keys: ["middle-click"], label: "Close a tab" },
    ],
  },
];

export function KeyChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono" style={{ minWidth: 24, height: 24, padding: "0 7px", borderRadius: 8, background: "var(--surface)", border: 0, boxShadow: "0 0 0 1px var(--line-2), 0 1px 0 var(--line-2)", display: "inline-grid", placeItems: "center", fontSize: 11.5, fontWeight: 500, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mod = isMac() ? "⌘" : "Ctrl";
  return (
    <Dialog onClose={onClose} width={620}>
      <DialogHeader icon="keyboard" title="Keyboard shortcuts" sub="Press ? anywhere to bring this up again." onClose={onClose} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))", gap: 22 }}>
        {GROUPS.map((g) => (
          <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 8px 8px", borderRadius: 18, background: "var(--fill-1)" }}>
            <span className="section-label" style={{ padding: "0 10px 6px" }}>{g.title}</span>
            {g.items.map((it) => (
              <div key={it.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 10px", borderRadius: 10, fontSize: 13, fontWeight: 600 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
                  {it.keys.map((k, i) => (
                    <span key={i} style={{ display: "contents" }}>
                      {i > 0 && it.keys[0] === "G" && <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 500 }}>then</span>}
                      <KeyChip>{k === "mod" ? mod : k}</KeyChip>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.(".xterm, [contenteditable='true']");
}

export function useGlobalShortcuts(shell: Shell, s: { paletteOpen: boolean; setPaletteOpen: (v: boolean) => void; keysOpen: boolean; setKeysOpen: (v: boolean) => void; blocked: boolean }) {
  const router = useRouter();
  const state = useRef(s);
  state.current = s;
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const gAt = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = state.current;
      const sh = shellRef.current;
      if (e.defaultPrevented) return;
      const k = e.key;

      // ⌘K / Ctrl+K toggles the palette from anywhere (not inside the terminal).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k.toLowerCase() === "k") {
        if (st.blocked) return;
        const el = e.target as HTMLElement | null;
        if (el?.closest?.(".xterm")) return;
        e.preventDefault();
        st.setPaletteOpen(!st.paletteOpen);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (st.blocked || st.paletteOpen || isTyping(e.target)) return;
      if (st.keysOpen) {
        if (k === "?") {
          e.preventDefault();
          st.setKeysOpen(false);
        }
        return;
      }

      const lower = k.toLowerCase();
      if (gAt.current && Date.now() - gAt.current < 1200) {
        gAt.current = 0;
        const dest: Record<string, string> = { f: "/", r: "/resources", m: "/machines", d: "/deploy", u: "/uptime", a: "/alerts", s: "/settings/hosts" };
        if (dest[lower]) {
          e.preventDefault();
          router.push(dest[lower]);
          return;
        }
      }
      if (k === "?") {
        e.preventDefault();
        st.setKeysOpen(true);
      } else if (k === "/") {
        e.preventDefault();
        st.setPaletteOpen(true);
      } else if (lower === "g" && !e.shiftKey) {
        gAt.current = Date.now();
      } else if (lower === "n" && !e.shiftKey) {
        e.preventDefault();
        sh.openNotifications();
      } else if (lower === "t" && !e.shiftKey) {
        e.preventDefault();
        sh.toggleTheme();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
}
