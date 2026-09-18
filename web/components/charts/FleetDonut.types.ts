import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const FleetDonutDatumSchema = z.object({
  name: z.string(),
  value: z.number(),
  color: z.string(),
});

export type FleetDonutDatum = z.infer<typeof FleetDonutDatumSchema>;

export interface FleetDonutProps {
  readonly data: readonly FleetDonutDatum[];
  /** Big number in the middle (defaults to the total). */
  readonly centerLabel?: string;
  /** Small label under it. */
  readonly centerSub?: string;
  /** Diameter in px (design: 104). */
  readonly size?: number;
  /** Controlled highlight so a legend can drive the chart and vice versa. */
  readonly highlight?: number | null;
  readonly onHover?: (i: number | null) => void;
  readonly onPointClick?: (datum: FleetDonutDatum) => void;
  readonly mode?: ChartMode;
  readonly className?: string;
}
