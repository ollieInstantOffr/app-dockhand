import type { UptimeBar } from "@/lib/types";
import type { UptimeBarsDatum } from "@/components/charts/UptimeBars.types";

/** Bucket range label: "Sep 17 14:00–15:00", or "Sep 17" / "Sep 17–18" for day-sized buckets. */
export function barLabel(fromIso: string, toIso: string): string {
  const f = new Date(fromIso);
  const t = new Date(toIso);
  const hm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (t.getTime() - f.getTime() >= 20 * 3600 * 1000) {
    const last = new Date(t.getTime() - 1);
    return day(f) === day(last) ? day(f) : `${day(f)}–${day(last)}`;
  }
  return `${day(f)} ${hm(f)}–${hm(t)}`;
}

/** Map API buckets to the UptimeBars chart rows, left-padded to 30 with "none". */
export function toUptimeData(bars: UptimeBar[], count = 30): UptimeBarsDatum[] {
  const rows: UptimeBarsDatum[] = bars.slice(-count).map((b) => ({ label: barLabel(b.from, b.to), value: b.pct, status: b.status }));
  while (rows.length < count) rows.unshift({ label: "No data yet", value: 0, status: "none" });
  return rows;
}
