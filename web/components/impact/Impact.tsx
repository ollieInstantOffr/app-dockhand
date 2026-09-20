"use client";

import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { C, plural } from "@/lib/format";
import type { Impact, ImpactItem } from "@/lib/types";
import { Dialog, DialogHeader } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";

// Blast radius: what an action would take down, shown before it is taken.

const SEV: Record<ImpactItem["severity"], string> = { crit: C.crit, warn: C.warn, info: "var(--ink-3)" };
const KIND_ICON: Record<string, IconName> = { container: "box", stack: "layers", monitor: "pulse", port: "network", service: "cpu", host: "server" };

/** Fetches a blast radius; pass null to skip. */
export function useImpact(path: string | null) {
  return useApi<Impact>(path, { revalidateOnFocus: false, refresh: 0 });
}

/** Confirm-dialog rows summarising an impact, for shell.confirm({ details }). */
export function impactDetails(i: Impact | undefined): { k: string; v: string }[] {
  if (!i) return [];
  const out: { k: string; v: string }[] = [];
  if (i.stops.length) out.push({ k: "Containers that stop", v: `${i.stops.length} — ${i.stops.slice(0, 3).map((x) => x.name).join(", ")}${i.stops.length > 3 ? "…" : ""}` });
  if (i.stacks.length) out.push({ k: "Stacks affected", v: i.stacks.map((x) => x.name).join(", ") });
  if (i.ports.length) out.push({ k: "Ports going quiet", v: i.ports.map((x) => x.name).join(", ").slice(0, 60) });
  if (i.monitors.length) out.push({ k: "Uptime checks that will fail", v: i.monitors.map((x) => x.name).join(", ") });
  for (const s of i.safe) out.push({ k: "Comes back", v: s });
  return out;
}

function Group({ title, items, onOpen }: { title: string; items: ImpactItem[]; onOpen: (i: ImpactItem) => void }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="section-label">
        {title} · {items.length}
      </span>
      <div style={{ display: "flex", flexDirection: "column", borderRadius: 14, border: "1px solid var(--line-1)", overflow: "hidden" }}>
        {items.slice(0, 40).map((i) => (
          <button
            key={`${i.kind}-${i.name}`}
            type="button"
            className="row-hover"
            onClick={() => onOpen(i)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid var(--line-1)", border: 0, background: "transparent", cursor: i.href ? "pointer" : "default", textAlign: "left", font: "inherit", color: "var(--ink)" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV[i.severity], flex: "none" }} />
            <Icon name={KIND_ICON[i.kind] ?? "dots"} size={14} color="var(--ink-3)" />
            <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600, flex: "0 1 auto", minWidth: 0 }}>{i.name}</span>
            <span className="ellipsis" style={{ fontSize: 12, color: "var(--ink-3)", flex: 1, minWidth: 0, textAlign: "right" }}>{i.detail}</span>
          </button>
        ))}
        {items.length > 40 && <span style={{ padding: "8px 12px", fontSize: 12, color: "var(--ink-3)" }}>and {items.length - 40} more</span>}
      </div>
    </div>
  );
}

/** The full report: what stops, what notices, and what comes back by itself. */
export function ImpactPanel({ impact, loading }: { impact?: Impact; loading?: boolean }) {
  const router = useRouter();
  if (loading || !impact) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="skel" style={{ height: 46, borderRadius: 14 }} />
        ))}
      </div>
    );
  }
  const tone = impact.severity === "crit" ? C.crit : impact.severity === "warn" ? C.warn : C.ok;
  const open = (i: ImpactItem) => i.href && router.push(i.href);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)" }}>
        <span style={{ width: 30, height: 30, borderRadius: 10, background: `${tone}22`, color: tone, display: "grid", placeItems: "center", flex: "none" }}>
          <Icon name={impact.severity === "info" ? "check" : "alert"} size={16} strokeWidth={2.4} />
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 }}>{impact.summary}</span>
      </div>
      <Group title="Containers that stop" items={impact.stops} onOpen={open} />
      <Group title="Uptime checks that will fail" items={impact.monitors} onOpen={open} />
      <Group title="Published ports going quiet" items={impact.ports} onOpen={open} />
      <Group title="Stacks affected" items={impact.stacks} onOpen={open} />
      <Group title="May depend on it" items={impact.depends} onOpen={open} />
      {impact.safe.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {impact.safe.map((s) => (
            <span key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)" }}>
              <Icon name="check" size={13} color={C.ok} strokeWidth={2.6} />
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** "What breaks?" as a dialog. */
export function ImpactDialog({ path, title, sub, onClose }: { path: string; title: string; sub?: string; onClose: () => void }) {
  const { data, error } = useImpact(path);
  return (
    <Dialog onClose={onClose} width={620}>
      <DialogHeader icon="alert" title={title} sub={sub ?? "What stops if you do this"} onClose={onClose} />
      {error ? <span style={{ fontSize: 13, color: "var(--crit-ink)" }}>{error.message}</span> : <ImpactPanel impact={data} loading={!data} />}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn2 lg" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** Short line for inline use, e.g. "4 containers stop · 1 check fails". */
export function impactLine(i: Impact | undefined): string {
  if (!i) return "";
  const bits: string[] = [];
  if (i.stops.length) bits.push(`${plural(i.stops.length, "container")} stop`);
  if (i.monitors.length) bits.push(`${plural(i.monitors.length, "check")} fail`);
  if (!bits.length) return "Nothing running stops";
  return bits.join(" · ");
}
