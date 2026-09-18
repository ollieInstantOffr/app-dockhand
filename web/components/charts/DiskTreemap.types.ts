import type { CSSProperties, ReactNode } from "react";
import { z } from "zod";
import type { ChartMode } from "./graphite/Chart";

/** Runtime schema — single source of truth; the TS type is inferred from it. */
export const DiskTreemapDatumSchema = z.object({
  name: z.string(),
  value: z.number(), // bytes
  color: z.string(), // cell background
  ink: z.string().optional(), // text colour on the cell
  sub: z.string().optional(), // e.g. "3.1 GB reclaimable"
  reclaimable: z.boolean().optional(), // dashed outline
});

export type DiskTreemapDatum = z.infer<typeof DiskTreemapDatumSchema>;

export interface DiskTreemapProps {
  readonly data: readonly DiskTreemapDatum[];
  readonly height?: number;
  readonly formatValue?: (v: number) => string;
  readonly highlight?: number | null;
  readonly onHover?: (i: number | null) => void;
  readonly onPointClick?: (datum: DiskTreemapDatum) => void;
  readonly renderCell?: (d: DiskTreemapDatum, hovered: boolean) => ReactNode;
  readonly cellStyle?: (d: DiskTreemapDatum, hovered: boolean) => CSSProperties;
  readonly mode?: ChartMode;
  readonly className?: string;
}
