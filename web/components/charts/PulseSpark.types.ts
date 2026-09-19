import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const PulseSparkDatumSchema = z.object({
  at: z.string(), // ISO timestamp of the bucket
  value: z.number(), // percent
});

export type PulseSparkDatum = z.infer<typeof PulseSparkDatumSchema>;

export interface PulseSparkProps {
  readonly data: readonly PulseSparkDatum[];
  readonly color: string;
  /** Dashed line at this value (the "hot" mark). */
  readonly threshold?: number;
  readonly mode?: ChartMode;
  readonly className?: string;
}
