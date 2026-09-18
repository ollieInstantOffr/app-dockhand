import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const UptimeBarsDatumSchema = z.object({
  label: z.string(), // bucket range, e.g. "Sep 17 14:00–15:00"
  value: z.number(), // uptime % in the bucket
  status: z.enum(["up", "degraded", "down", "unknown", "paused", "none"]),
});

export type UptimeBarsDatum = z.infer<typeof UptimeBarsDatumSchema>;

export interface UptimeBarsProps {
  readonly data: readonly UptimeBarsDatum[];
  readonly height?: number;
  /** Gap between bars (design: tighter on narrow cards). */
  readonly gap?: number;
  readonly mode?: ChartMode;
  readonly className?: string;
}
