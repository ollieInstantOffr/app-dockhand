"use client";

import { Dropdown } from "../ui";
import { Icon } from "../icons";
import { NO_STACK, SORTS, STATUS_FILTERS, statusCounts, type ContainerView, type SortKey, type StatusFilter } from "@/lib/containerFilters";
import type { Container } from "@/lib/types";

/** Status chips with counts, stack filter, sort and "select all shown" for the Containers tab. */
export function ContainerFilters({
  containers,
  view,
  shown,
  onChange,
  onSelectShown,
}: {
  containers: Container[];
  view: ContainerView;
  shown: number;
  onChange: (p: Partial<ContainerView>) => void;
  onSelectShown: () => void;
}) {
  // Counts respect the stack and text filters so the numbers match what a click shows.
  const scoped = containers.filter((c) => (!view.stack || (view.stack === NO_STACK ? !c.stack : c.stack === view.stack)));
  const counts = statusCounts(scoped);
  const stacks = Array.from(new Set(containers.map((c) => c.stack).filter(Boolean))).sort();
  const hasLoose = containers.some((c) => !c.stack);
  const filtered = view.status !== "all" || !!view.stack || !!view.q || view.sort !== "status";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: -6 }}>
      <div role="radiogroup" aria-label="Filter by status" style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
        {STATUS_FILTERS.filter((f) => f.always || counts[f.value] > 0 || view.status === f.value).map((f) => {
          const on = view.status === f.value;
          return (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`cf-chip${on ? " on" : ""}`}
              onClick={() => onChange({ status: on && f.value !== "all" ? "all" : f.value })}
            >
              {f.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: f.color, flex: "none", boxShadow: f.value === "unhealthy" || f.value === "crashed" ? `0 0 8px ${f.color}` : undefined }} />}
              {f.label}
              <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{counts[f.value]}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {(stacks.length > 0 || view.stack) && (
          <div style={{ width: 180 }}>
            <Dropdown<string>
              value={view.stack || "__all__"}
              options={[
                { value: "__all__", label: "All stacks" },
                ...stacks.map((s) => ({ value: s, label: s, sub: String(containers.filter((c) => c.stack === s).length) })),
                ...(hasLoose ? [{ value: NO_STACK, label: "No stack", sub: String(containers.filter((c) => !c.stack).length) }] : []),
              ]}
              onChange={(v) => onChange({ stack: v === "__all__" ? "" : v })}
              icon={<span style={{ display: "flex", color: "var(--ink-3)" }}><Icon name="layers" size={14} /></span>}
            />
          </div>
        )}
        <div style={{ width: 172 }}>
          <Dropdown<SortKey>
            value={view.sort}
            options={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))}
            onChange={(v) => onChange({ sort: v })}
            icon={<span style={{ display: "flex", color: "var(--ink-3)" }}><Icon name="sliders" size={14} /></span>}
          />
        </div>
        {shown > 0 && (
          <button type="button" className="btn2" style={{ height: 40 }} onClick={onSelectShown} title="Select every container shown for Start / Restart / Stop">
            <Icon name="check" size={14} strokeWidth={2.2} />
            Select {shown}
          </button>
        )}
        {filtered && (
          <button type="button" className="btn-link" onClick={() => onChange({ status: "all", stack: "", q: "", sort: "status" })}>
            Clear
          </button>
        )}
      </div>
      <style>{`.cf-chip{display:flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:11px;border:0;background:var(--fill-1);color:var(--ink);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s}
.cf-chip:hover{background:var(--fill-2)}
.cf-chip.on{background:var(--btn);color:var(--btn-ink)}`}</style>
    </div>
  );
}

export type { StatusFilter };
