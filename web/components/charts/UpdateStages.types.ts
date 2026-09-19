import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const UpdateStagesDatumSchema = z.object({
  label: z.string(), // "Back up", "Rebuild", …
  value: z.number(), // progress within the stage, 0–100
  status: z.enum(["done", "active", "pending", "skipped", "failed"]),
});

export type UpdateStagesDatum = z.infer<typeof UpdateStagesDatumSchema>;

export interface UpdateStagesProps {
  readonly data: readonly UpdateStagesDatum[];
  readonly height?: number;
  readonly gap?: number;
  readonly mode?: ChartMode;
}
