import type { CSSProperties, ReactNode } from "react";
import { Logo } from "@/components/icons";

const cardStyle: CSSProperties = {
  border: 0,
  background: "var(--surface)",
  boxShadow: "0 1px 2px rgba(20,24,40,.05), 0 30px 80px rgba(20,24,40,.16)",
  borderRadius: 28,
  padding: "0 0 30px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  animation: "pop .4s var(--ease) both",
};

/** The light Dockhand mark on a dark ink tile (design `ic.logoOnInkLg`). */
export function LogoTile({ size = 52 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.31), background: "linear-gradient(145deg,#2a3044,#14171f)", display: "grid", placeItems: "center", boxShadow: "0 0 0 2px rgba(255,255,255,.12)", flex: "none" }}>
      <Logo size={Math.round(size * 0.56)} color="#fff" />
    </div>
  );
}

/** Centered solid card with a dark header band (logo tile + title) — login + onboarding. */
export function AuthCard({ width, gap, title, sub, children }: { width: number; gap: number; title: ReactNode; sub: ReactNode; children: ReactNode }) {
  return (
    <section style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ ...cardStyle, width: `min(${width}px,100%)`, gap }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "26px 30px", background: "var(--btn)", color: "var(--btn-ink)" }}>
          <LogoTile />
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{title}</div>
            <div style={{ fontSize: 13, opacity: 0.65 }}>{sub}</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap, padding: "0 30px" }}>{children}</div>
      </div>
    </section>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)", lineHeight: 1.5 }}>
      {children}
    </div>
  );
}
