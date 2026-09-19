"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { UpdateStagesDatum, UpdateStagesProps } from "./UpdateStages.types";

const X_KEY = "label" as const satisfies keyof UpdateStagesDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof UpdateStagesDatum)[];

const STATUS_COLOR: Record<UpdateStagesDatum["status"], string> = {
  done: "#22a06b",
  active: "#2f6fed",
  pending: "var(--track)",
  skipped: "#9aa1ad",
  failed: "#e2504c",
};

const STATUS_TEXT: Record<UpdateStagesDatum["status"], string> = {
  done: "done",
  active: "in progress",
  pending: "waiting",
  skipped: "skipped",
  failed: "failed",
};

/**
 * UpdateStages — Graphite bar chart as a full-height status strip (like the
 * uptime bars): one segment per update stage, the colour carries its state and
 * the active segment fills in as the stage progresses, with the labels below.
 */
export function UpdateStages({ data, height = 10, gap = 4, mode = graphiteTheme.defaultMode }: UpdateStagesProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
      <div style={{ height, width: "100%", minWidth: 0, ["--bar-r" as string]: "3px" }}>
        <Chart
          compact
          fullHeight
          type="bar"
          theme={graphiteTheme}
          mode={mode}
          data={data}
          x={X_KEY}
          value={VALUE_KEYS}
          title="Update stages"
          unit="%"
          gap={gap}
          max={100}
          colorOf={(r) => STATUS_COLOR[r.status]}
          opacityOf={(r) => (r.status === "active" ? 0.45 + Math.min(100, Math.max(0, r.value)) / 180 : 1)}
          tipOf={(r) => `${r.label} · ${STATUS_TEXT[r.status]}`}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${data.length}, minmax(0,1fr))`, gap }}>
        {data.map((r) => (
          <span
            key={r.label}
            className="ellipsis"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: r.status === "active" ? "var(--ink)" : r.status === "failed" ? "var(--crit-ink)" : "var(--ink-3)",
              opacity: r.status === "pending" ? 0.7 : 1,
            }}
          >
            {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}
