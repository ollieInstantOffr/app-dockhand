import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const RingGaugeDatumSchema = z.object({
  label: z.string(),
  value: z.number(),
});

export type RingGaugeDatum = z.infer<typeof RingGaugeDatumSchema>;

export interface RingGaugeProps {
  /** Metric name, e.g. "CPU". */
  readonly label: string;
  /** 0–100. */
  readonly value: number;
  /** Arc colour (defaults to the first palette colour). */
  readonly color?: string;
  /** Diameter in px (design: 44 on cards, 48 in the host header). */
  readonly size?: number;
  /** Overrides the centre text (defaults to "N%"). */
  readonly centerLabel?: string;
  readonly mode?: ChartMode;
  readonly className?: string;
}
