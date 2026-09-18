import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const SparkBarsDatumSchema = z.object({
  label: z.string(),
  value: z.number(),
});

export type SparkBarsDatum = z.infer<typeof SparkBarsDatumSchema>;

export interface SparkBarsProps {
  /** Samples, oldest first. Plain numbers get index labels. */
  readonly data: readonly (SparkBarsDatum | number)[];
  /** Pad/trim to exactly this many bars (padding on the left with empty bars). */
  readonly count?: number;
  /** Bar colour, or a function of the value (e.g. amber ≥ 75, red ≥ 90). */
  readonly color?: string | ((v: number) => string);
  /** Scale max (default max(100, data max)). */
  readonly max?: number;
  readonly height?: number;
  readonly gap?: number;
  readonly radius?: number;
  /** Fade older bars (design sparklines get stronger toward "now"). Default true. */
  readonly fade?: boolean;
  readonly unit?: string;
  readonly formatValue?: (v: number) => string;
  readonly title?: string;
  readonly mode?: ChartMode;
  readonly className?: string;
}
