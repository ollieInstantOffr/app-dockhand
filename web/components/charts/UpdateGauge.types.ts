import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const UpdateGaugeDatumSchema = z.object({
  label: z.string(),
  value: z.number(), // overall progress, 0–100
});

export type UpdateGaugeDatum = z.infer<typeof UpdateGaugeDatumSchema>;

export interface UpdateGaugeProps {
  /** Overall progress 0–100. */
  readonly value: number;
  readonly tone: "run" | "ok" | "crit";
  /** Arc width in px (height is 0.625×). */
  readonly width?: number;
  readonly mode?: ChartMode;
}
