"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { DiskTreemapDatum, DiskTreemapProps } from "./DiskTreemap.types";

const X_KEY = "name" as const satisfies keyof DiskTreemapDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof DiskTreemapDatum)[];

/** DiskTreemap — Graphite treemap in compact form (docker disk usage by category). */
export function DiskTreemap({ data, height = 220, formatValue = String, highlight, onHover, onPointClick, renderCell, cellStyle, mode = graphiteTheme.defaultMode, className }: DiskTreemapProps) {
  return (
    <div style={{ height, width: "100%", margin: -3 }} className={className}>
      <Chart
        compact
        type="treemap"
        theme={graphiteTheme}
        mode={mode}
        data={data}
        x={X_KEY}
        value={VALUE_KEYS}
        title="Disk usage"
        highlight={highlight}
        onHover={onHover}
        onPointClick={onPointClick}
        cellStyle={(d, _i, h) => ({
          background: d.color,
          color: d.ink ?? "#fff",
          border: d.reclaimable ? `1.5px dashed ${d.ink ?? "currentColor"}` : "1.5px solid transparent",
          ...(cellStyle ? cellStyle(d, h) : null),
        })}
        renderCell={(d, _i, h) =>
          renderCell ? (
            renderCell(d, h)
          ) : (
            <>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, maxWidth: "100%" }}>
                <span style={{ fontFamily: "Manrope, system-ui, sans-serif", fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
                <span style={{ fontSize: 11.5, opacity: 0.75 }}>{formatValue(d.value)}</span>
              </span>
              {d.sub && <span style={{ fontFamily: "Manrope, system-ui, sans-serif", fontSize: 11, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{d.sub}</span>}
            </>
          )
        }
      />
    </div>
  );
}
