"use client";

import { invalidate, post } from "@/lib/api";
import type { Alert } from "@/lib/types";

export type AlertFilter = "all" | "unread" | "critical";

export const ALERT_FILTERS: { value: AlertFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "critical", label: "Critical" },
];

/** Revalidate every alert list and the dock badge. */
export function refreshAlerts() {
  invalidate("/api/alerts");
  invalidate("/api/overview");
}

export async function markRead(id: string) {
  await post(`/api/alerts/${id}/read`);
  refreshAlerts();
}

export async function markAllRead() {
  await post("/api/alerts/read-all");
  refreshAlerts();
}

export async function snooze(id: string, minutes: number) {
  await post(`/api/alerts/${id}/snooze`, { minutes });
  refreshAlerts();
}

/** "3 unread · 1 critical" */
export function alertSummary(list: Alert[] | undefined): string {
  if (!list) return "Loading…";
  const unread = list.filter((a) => !a.read).length;
  const crit = list.filter((a) => a.severity === "crit" && !a.resolved).length;
  if (!unread && !crit) return list.length ? "All caught up" : "Nothing needs your attention";
  return [`${unread} unread`, crit ? `${crit} critical` : ""].filter(Boolean).join(" · ");
}

export function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
