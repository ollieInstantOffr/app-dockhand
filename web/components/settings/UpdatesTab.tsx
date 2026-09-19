"use client";

import { useEffect, useState } from "react";
import { Icon, Logo } from "@/components/icons";
import { Dropdown, LogBlock, Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, useApi, useJob } from "@/lib/api";
import { C, ago, shortSha } from "@/lib/format";
import type { JobLogLine, JobRef, Settings, SystemInfo, UpdateHistoryPage, UpdaterStatus } from "@/lib/types";
import { InkButton, InkHead, PILL, SetToggle, StatusPill, cardStyle, colStack, rowStyle, twoCol, useSettings } from "./common";

const WINDOWS = ["Sun 03:00–05:00", "Sat 02:00–04:00", "Daily 04:00–05:00", "Daily 03:00–04:00", "Weekdays 02:00–03:00", "Weekends 03:00–05:00", "Any time"];
// Versions read "v1.4.0"; commits (git-mode updates) read as a short sha.
const v = (s: string) => (!s ? "" : /^[0-9a-f]{7,40}$/.test(s) ? s.slice(0, 7) : `v${s.replace(/^v/, "")}`);

export function UpdatesTab() {
  const shell = useShell();
  const { data: sys, mutate } = useApi<SystemInfo>("/api/system");
  const [jobId, setJobId] = useState<string | null>(null);
  const [kind, setKind] = useState<"update" | "rollback">("update");
  const [checking, setChecking] = useState(false);
  const job = useJob(jobId);

  useEffect(() => {
    if (job && job.status !== "running") invalidate("/api/system");
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setChecking(true);
    try {
      const s = await post<SystemInfo>("/api/system/check");
      mutate(s, { revalidate: false });
      shell.toast({ kind: s.updateAvailable ? "info" : "ok", title: s.updateAvailable ? `${v(s.latest)} is available` : "You're up to date", text: s.updateAvailable ? undefined : `Dockhand ${v(s.version)} is the latest ${s.latest ? "release" : "version we know of"}.` });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't check for updates", text: errMsg(e) });
    } finally {
      setChecking(false);
    }
  };

  const start = async (k: "update" | "rollback") => {
    try {
      const r = await post<JobRef>(k === "update" ? "/api/system/update" : "/api/system/rollback");
      setKind(k);
      setJobId(r.jobId);
    } catch (e) {
      shell.toast({ kind: "error", title: k === "update" ? "Couldn't start the update" : "Couldn't start the rollback", text: errMsg(e) });
    }
  };

  const rollback = async () => {
    const prev = sys?.history.find((h) => h.version !== sys.version);
    const ok = await shell.confirm({
      title: "Roll back Dockhand?",
      text: `Dockhand restarts on the previous version${prev ? ` (${v(prev.version)})` : ""}. Your containers keep running and the database backup from before the last update is restored.`,
      confirmLabel: "Roll back",
      danger: true,
      icon: "restart",
    });
    if (ok) start("rollback");
  };

  return (
    <div style={twoCol(380)}>
      <div style={colStack}>
        <VersionCard sys={sys} job={job} jobKind={kind} checking={checking} onCheck={check} onUpdate={() => start("update")} onDismiss={() => setJobId(null)} />
        <AutoCard sys={sys} />
      </div>
      <div style={colStack}>
        <SourceCard sys={sys} />
        <HistoryCard sys={sys} busy={!!job && job.status === "running"} onRollback={rollback} />
      </div>
    </div>
  );
}

function VersionCard({ sys, job, jobKind, checking, onCheck, onUpdate, onDismiss }: { sys?: SystemInfo; job: ReturnType<typeof useJob>; jobKind: "update" | "rollback"; checking: boolean; onCheck: () => void; onUpdate: () => void; onDismiss: () => void }) {
  const busy = !!job;
  // In git mode the job hands off to a detached updater; the update is still in progress after the job "succeeds".
  const handedOff = job?.status === "success" && job.result?.handedOff === true && sys?.mode === "git";
  const running = job?.status === "running" || handedOff;
  const pill = running ? { ...PILL.blue, label: jobKind === "update" ? "Updating" : "Rolling back" } : sys?.updateAvailable ? { ...PILL.warn, label: "Update available" } : { ...PILL.ok, label: "Up to date" };
  const status = !sys
    ? "Checking…"
    : running
      ? jobKind === "update" ? `Updating to ${v(sys.latest)} — Dockhand restarts, your containers don't` : "Rolling back to the previous version"
      : sys.updateAvailable
        ? `${v(sys.latest)} available · checked ${ago(sys.checkedAt)}`
        : `Latest version · checked ${ago(sys.checkedAt)}`;
  const target = (job?.result?.version as string | undefined) || sys?.latest || "";

  return (
    <div className="glass-card" style={cardStyle(18)}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ width: 52, height: 52, borderRadius: 16, background: "linear-gradient(145deg,#1b1f2a,#3a4258)", display: "grid", placeItems: "center", flex: "none", boxShadow: "0 8px 20px rgba(0,0,0,.2)" }}>
          <Logo size={28} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>
            Dockhand <span className="mono" style={{ fontWeight: 500, color: "var(--ink-3)" }}>{sys ? v(sys.version) : ""}{sys?.currentCommit ? ` · ${sys.currentCommit}` : ""}</span>
          </span>
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{status}</span>
        </div>
        {sys && <StatusPill bg={pill.bg} color={pill.color}>{pill.label}</StatusPill>}
      </div>

      {!sys && <span className="skel" style={{ height: 90, borderRadius: 14 }} />}

      {sys && !busy && (
        <>
          {sys.updateAvailable ? (
            <div style={rowStyle(true, { alignItems: "flex-start", padding: 14 })}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(47,111,237,.12)", color: C.blue, display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name="update" size={17} />
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>
                  {sys.mode === "git" ? `${sys.notes.length || "New"} new commit${sys.notes.length === 1 ? "" : "s"} on ${sys.source.branch}` : `${v(sys.latest)} is available`}
                  {sys.releasedAt && <span style={{ fontWeight: 500, color: "var(--ink-3)" }}> · {sys.mode === "git" ? "pushed" : "released"} {ago(sys.releasedAt)}</span>}
                </span>
                {!!sys.notes.length && (
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
                    {sys.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
                {(sys.changelogUrl || sys.source.repo) && (
                  <a href={sys.changelogUrl || `https://github.com/${sys.source.repo}/releases`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, alignSelf: "flex-start" }}>{sys.mode === "git" ? "Compare on GitHub →" : "Full changelog on GitHub →"}</a>
                )}
              </div>
            </div>
          ) : (
            <div style={rowStyle(true, { padding: 14 })}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(34,160,107,.12)", color: C.ok, display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name="check" size={17} strokeWidth={2.2} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>You&apos;re on the latest version</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{sys.checkError
                    ? sys.checkError
                    : sys.mode === "git"
                      ? `Running ${sys.currentCommit}, the latest commit on ${sys.source.branch} of ${sys.source.repo}.`
                      : sys.latest
                        ? `${v(sys.latest)} is the newest release on this channel.`
                        : "Couldn't reach the release feed — try Check now."}</span>
                {sys.source.repo && (
                  <a href={sys.mode === "git" ? `https://github.com/${sys.source.repo}/commits/${sys.source.branch}` : sys.changelogUrl || `https://github.com/${sys.source.repo}/releases`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>Release notes on GitHub →</a>
                )}
              </span>
            </div>
          )}
          {!sys.canSelfUpdate && (
            <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--warn-bg)", border: "1px solid rgba(224,160,32,.3)", fontSize: 12.5, color: "var(--warn-ink)", lineHeight: 1.5 }}>
              Dockhand can&apos;t update itself: the Docker socket isn&apos;t mounted into its container. Update from the host with <code className="mono">docker compose pull &amp;&amp; docker compose up -d</code>.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {sys.updateAvailable && (
              <button type="button" className="btn" onClick={onUpdate} disabled={!sys.canSelfUpdate}>
                <Icon name="update" size={16} />
                Update to {v(sys.latest)}
              </button>
            )}
            <button type="button" className="btn2 lg" onClick={onCheck} disabled={checking}>
              {checking && <span className="spinner" style={{ width: 12, height: 12 }} />}
              Check now
            </button>
            <span style={{ alignSelf: "center", fontSize: 12, color: "var(--ink-3)" }}>Takes ~2 min · Dockhand restarts, your containers don&apos;t</span>
          </div>
        </>
      )}

      {job && (
        <>
          {!(job.status === "success" && job.result?.handedOff === true && sys?.mode === "git") && (
            <>
              <JobProgress steps={job.steps} status={job.status} scale={job.result?.handedOff === true || (sys?.mode === "git" && jobKind === "update") ? HANDOFF_PCT : 100} />
              <Details lines={job.log} running={running} open={job.status === "failed"} />
            </>
          )}
          {job.status === "success" && job.result?.handedOff === true && sys?.mode === "git" && <UpdaterWatch target={target} jobLog={job.log} startedAt={job.startedAt} onDismiss={onDismiss} />}
          {job.status === "success" && !(job.result?.handedOff === true && sys?.mode === "git") && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "rgba(34,160,107,.1)", border: "1px solid rgba(34,160,107,.3)", animation: "rise .3s ease both" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.ok, color: "#fff", display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name="check" size={15} strokeWidth={2.6} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ok-ink)", flex: 1 }}>
                {jobKind === "update" ? `Updated to ${v(target)} — reload to finish.` : "Rolled back — reload to finish."}
              </span>
              <button type="button" className="btn" style={{ height: 34, padding: "0 14px", fontSize: 12.5 }} onClick={() => window.location.reload()}>Reload</button>
            </div>
          )}
          {job.status === "failed" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--crit-ink)", flex: 1 }}>
                {jobKind === "update" ? "The update failed — Dockhand is still on" : "The rollback failed — Dockhand is still on"} {sys ? v(sys.version) : "the current version"}.
              </span>
              <button type="button" className="btn2" onClick={onDismiss}>Dismiss</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Follows the detached updater after the API hands off: shows its output, reports
 * failures, and reloads once the API is back on the new commit.
 */
function UpdaterWatch({ target, jobLog, startedAt, onDismiss }: { target: string; jobLog: JobLogLine[]; startedAt?: string; onDismiss: () => void }) {
  const [st, setSt] = useState<UpdaterStatus | null>(null);
  const [down, setDown] = useState(false);
  const [live, setLive] = useState<string>("");
  // Elapsed time counts from the start of the whole update, not the hand-off.
  const [started] = useState(() => {
    const t = startedAt ? Date.parse(startedAt) : NaN;
    return Number.isFinite(t) && t <= Date.now() ? t : Date.now();
  });
  const [now, setNow] = useState(Date.now());
  const done = !!live && target && live.startsWith(target.slice(0, 7));
  const failed = st?.state === "failed";
  const slow = !done && !failed && now - started > 6 * 60_000;

  useEffect(() => {
    if (done || failed) return;
    let alive = true;
    const tick = async () => {
      setNow(Date.now());
      try {
        const r = await fetch("/api/system/updater", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as UpdaterStatus;
        if (!alive) return;
        setSt(s);
        setDown(false);
        const i = await fetch("/api/system", { credentials: "same-origin", cache: "no-store" });
        if (i.ok) {
          const info = (await i.json()) as SystemInfo;
          if (alive && info.currentCommit) setLive(info.currentCommit);
        }
      } catch {
        if (alive) setDown(true); // the API is restarting
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [done, failed]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => window.location.reload(), 2500);
    return () => clearTimeout(t);
  }, [done]);

  const lines = (st?.log ?? []).map((text) => ({ text, level: (/error|fatal|failed|denied/i.test(text) ? "error" : text.startsWith("==>") ? "ok" : "info") as "error" | "ok" | "info" }));

  // Where the updater is, read from its "==> …" markers and docker build's "[n/m]" step counters.
  const log = st?.log ?? [];
  const has = (m: string) => log.some((l) => l.startsWith(`==> ${m}`));
  const [rebuildAt, setRebuildAt] = useState<number | null>(null);
  const rebuilding = has("rebuilding") && !has("done");
  useEffect(() => {
    if (rebuilding && rebuildAt == null) setRebuildAt(Date.now());
  }, [rebuilding, rebuildAt]);
  let buildFrac = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].match(/\[[^\]]*?(\d+)\/(\d+)\]/);
    if (m && Number(m[2]) > 0) {
      buildFrac = Number(m[1]) / Number(m[2]);
      break;
    }
  }
  const timeFrac = rebuildAt ? 1 - Math.exp(-(now - rebuildAt) / 70_000) : 0; // most rebuilds take 1–2 minutes
  const stages: { key: string; label: string; from: number; to: number }[] = [
    { key: "prepare", label: "Starting the updater", from: HANDOFF_PCT, to: 26 },
    { key: "fetch", label: "Fetching the new code", from: 26, to: 34 },
    { key: "build", label: "Rebuilding Dockhand", from: 34, to: 84 },
    { key: "restart", label: "Restarting on the new version", from: 84, to: 97 },
    { key: "done", label: "Done", from: 100, to: 100 },
  ];
  const restarting = !done && (down || st?.state === "succeeded" || has("done"));
  const [restartAt, setRestartAt] = useState<number | null>(null);
  useEffect(() => {
    if (restarting && restartAt == null) setRestartAt(Date.now());
  }, [restarting, restartAt]);
  const stageKey = done ? "done" : down || st?.state === "succeeded" || has("done") ? "restart" : has("rebuilding") ? "build" : has("fetching") || has("now at") ? "fetch" : "prepare";
  const stage = stages.find((x) => x.key === stageKey)!;
  const within = stageKey === "build" ? Math.max(buildFrac * 0.95, timeFrac * 0.9) : stageKey === "restart" ? (restartAt ? 1 - Math.exp(-(now - restartAt) / 25_000) : 0) : 0.5;
  const raw = done ? 100 : stage.from + (stage.to - stage.from) * Math.min(1, within);
  // Never move backwards (the updater log can reset while the API restarts).
  const [peak, setPeak] = useState(HANDOFF_PCT);
  useEffect(() => {
    if (raw > peak) setPeak(raw);
  }, [raw, peak]);
  const pct = failed ? peak : Math.max(peak, raw);
  const stepNo = stages.findIndex((x) => x.key === stageKey) + 3; // after "Backing up" and "Preparing"
  const elapsed = Math.max(0, Math.round((now - started) / 1000));
  const title = done ? `Updated to ${target.slice(0, 7)}` : failed ? "The update failed" : slow ? "This is taking longer than expected" : stage.label;
  const sub = done
    ? "Reloading…"
    : failed
      ? `Exit ${st?.exitCode ?? "?"} — Dockhand is still running the previous version.`
      : `Step ${Math.min(stepNo, 6)} of 6 · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} elapsed · usually about 2 minutes`;
  return (
    <>
      <ProgressBar pct={pct} tone={done ? "ok" : failed || slow ? "crit" : "run"} title={title} sub={sub}>
        {done && <button type="button" className="btn" style={{ height: 34, padding: "0 14px", fontSize: 12.5 }} onClick={() => window.location.reload()}>Reload</button>}
        {(failed || slow) && <button type="button" className="btn2" onClick={onDismiss}>Dismiss</button>}
      </ProgressBar>
      <Details lines={[...jobLog, ...lines]} running={!done && !failed} open={failed || slow}>
        {st?.id && (failed || slow) && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Full output on the host: <code className="mono">docker logs {st.id}</code>
          </span>
        )}
      </Details>
    </>
  );
}

/** Share of the bar covered by the API's own job before it hands off to the updater (git mode). */
const HANDOFF_PCT = 20;

/** Progress for the API-side job: its steps mapped onto 0–scale%. */
function JobProgress({ steps, status, scale }: { steps: { label: string; status: string }[]; status: string; scale: number }) {
  const total = Math.max(1, steps.length);
  const done = steps.filter((x) => x.status === "done" || x.status === "skipped").length;
  const cur = steps.find((x) => x.status === "running") ?? steps.find((x) => x.status === "failed");
  const idx = cur ? steps.indexOf(cur) : done;
  const pct = status === "success" ? scale : ((done + (cur?.status === "running" ? 0.5 : 0)) / total) * scale;
  const failed = status === "failed";
  const ofN = scale < 100 ? 6 : total;
  return (
    <ProgressBar
      pct={Math.max(3, pct)}
      tone={failed ? "crit" : status === "success" ? "ok" : "run"}
      title={failed ? `Failed: ${cur?.label ?? "update"}` : status === "success" ? "Done" : cur?.label ?? "Starting…"}
      sub={failed ? "Nothing was changed — Dockhand is still on the current version." : `Step ${Math.min(idx + 1, ofN)} of ${ofN}`}
    />
  );
}

function ProgressBar({ pct, tone, title, sub, children }: { pct: number; tone: "run" | "ok" | "crit"; title: string; sub?: string; children?: React.ReactNode }) {
  const color = tone === "ok" ? C.ok : tone === "crit" ? C.crit : C.blue;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 16, background: "var(--fill-1)", animation: "rise .3s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {tone === "ok" ? (
          <span style={{ width: 26, height: 26, borderRadius: "50%", background: C.ok, color: "#fff", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name="check" size={14} strokeWidth={2.6} />
          </span>
        ) : tone === "crit" ? (
          <span style={{ width: 26, height: 26, borderRadius: "50%", background: C.crit, color: "#fff", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name="x" size={13} strokeWidth={2.6} />
          </span>
        ) : (
          <span className="spinner" style={{ width: 16, height: 16, color: C.blue, flex: "none", margin: 5 }} />
        )}
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: tone === "crit" ? "var(--crit-ink)" : "var(--ink)" }}>{title}</span>
          {sub && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</span>}
        </span>
        <span className="mono" style={{ fontSize: 13, fontWeight: 700, color }}>{Math.round(p)}%</span>
        {children}
      </div>
      <div style={{ height: 8, borderRadius: 99, background: "rgba(127,127,127,.18)", overflow: "hidden" }}>
        <div className={tone === "run" ? "upd-bar run" : "upd-bar"} style={{ width: `${p}%`, height: "100%", borderRadius: 99, background: color, transition: "width .8s cubic-bezier(.2,.8,.2,1)" }} />
      </div>
      <style>{`.upd-bar.run{background-image:linear-gradient(45deg,rgba(255,255,255,.22) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.22) 50%,rgba(255,255,255,.22) 75%,transparent 75%,transparent);background-size:16px 16px;animation:upd-stripes 1s linear infinite}@keyframes upd-stripes{from{background-position:0 0}to{background-position:16px 0}}@media (prefers-reduced-motion:reduce){.upd-bar.run{animation:none}}`}</style>
    </div>
  );
}

/** The raw output, collapsed unless something went wrong. */
function Details({ lines, running, open: initial, children }: { lines: JobLogLine[]; running: boolean; open?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(!!initial);
  useEffect(() => {
    if (initial) setOpen(true);
  }, [initial]);
  if (!lines.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, border: 0, background: "transparent", color: "var(--ink-3)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>
        <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }}>
          <Icon name="chevronRight" size={12} />
        </span>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && <LogBlock lines={lines} running={running} style={{ maxHeight: 220 }} />}
      {open && children}
    </div>
  );
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function zoneOptions(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    /* old browser */
  }
  const first = [browserZone(), "UTC"];
  if (current && !first.includes(current)) first.unshift(current);
  return [...new Set([...first, ...all])];
}

function whenText(iso: string, tz: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return d.toLocaleString(undefined, { ...opts, timeZone: tz });
  } catch {
    return d.toLocaleString(undefined, opts);
  }
}

function AutoCard({ sys }: { sys?: SystemInfo }) {
  const { settings, save } = useSettings();
  const u = settings?.updates;
  const saveU = (p: Partial<Settings["updates"]>) => save({ updates: p });
  const windows = u && !WINDOWS.includes(u.window) && u.window ? [u.window, ...WINDOWS] : WINDOWS;
  const auto = sys?.auto;
  const git = sys?.mode === "git";
  const zone = u?.timezone || auto?.timezone || "";
  const zones = zoneOptions(zone);
  // Turning it on for the first time pins the window to this browser's zone.
  const toggle = (on: boolean) => saveU(on && !u?.timezone ? { auto: on, timezone: browserZone() } : { auto: on });

  let status: { tone: "ok" | "warn" | "info" | "muted"; text: string } | null = null;
  if (u?.auto && auto) {
    if (auto.error) status = { tone: "warn", text: auto.error };
    else if (!sys?.canSelfUpdate) status = { tone: "warn", text: "Needs the Docker socket mounted into the API container." };
    else if (auto.inWindow) status = { tone: "ok", text: "Inside the update window now — checking every 5 minutes." };
    else if (auto.nextWindow) status = { tone: "info", text: `Next window opens ${whenText(auto.nextWindow, auto.timezone)} (${auto.timezone}).` };
  }
  const toneColor = { ok: C.ok, warn: C.warn, info: C.blue, muted: "var(--ink-3)" };

  return (
    <div className="glass-card" style={cardStyle(14)}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Automatic updates</div>
      <SetToggle label="Update automatically" sub={git ? "Pull new commits, rebuild and restart Dockhand inside the window" : "Install new releases and restart Dockhand inside the window"} on={!!u?.auto} disabled={!u} onChange={toggle} />
      {status && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 12, background: "var(--fill-1)", fontSize: 12.5, fontWeight: 600 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: toneColor[status.tone], flex: "none" }} />
          <span>{status.text}</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
        <div className="field">
          Window
          <Dropdown value={u?.window ?? ""} options={windows.map((w) => ({ value: w, label: w }))} onChange={(x) => saveU({ window: x })} />
        </div>
        <label className="field">
          Time zone
          <select className="input" value={zone} disabled={!u} onChange={(e) => saveU({ timezone: e.target.value })} style={{ height: 40 }}>
            {!zone && <option value="">Server time</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z === browserZone() ? `${z} (this browser)` : z}
              </option>
            ))}
          </select>
        </label>
      </div>
      {git ? (
        <span className="field-hint">
          Follows <span className="mono">{sys?.source.branch || "main"}</span> of <span className="mono">{sys?.source.repo}</span>. A version that fails to install is not retried automatically.
        </span>
      ) : (
        <div className="field">
          Channel
          <Seg<Settings["updates"]["channel"]> fit options={[{ value: "stable", label: "Stable" }, { value: "beta", label: "Beta" }, { value: "nightly", label: "Nightly" }]} value={u?.channel ?? "stable"} onChange={(x) => saveU({ channel: x })} />
        </div>
      )}
      <SetToggle label="Back up before updating" sub="Snapshot of the Dockhand database and config" on={!!u?.backup} disabled={!u} onChange={(x) => saveU({ backup: x })} />
      {u?.auto && auto?.lastCheck && (
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Last automatic check {ago(auto.lastCheck)}
          {auto.lastResult ? ` · ${auto.lastResult}` : ""}
        </span>
      )}
    </div>
  );
}

function SourceCard({ sys }: { sys?: SystemInfo }) {
  const { settings, save } = useSettings();
  const u = settings?.updates;
  const [compose, setCompose] = useState<string | null>(null);
  const composeVal = compose ?? u?.composeFile ?? "";
  const src = sys?.source;
  const git = sys?.mode === "git";
  const repo = (git ? src?.repo : u?.repo) || src?.repo || "";
  const branch = src?.branch || "main";
  return (
    <div className="glass-card" style={cardStyle(14)}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Source</div>
      <div style={rowStyle(true)}>
        <span style={{ width: 32, height: 32, borderRadius: 10, background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
          <Icon name="branch" size={16} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
          {repo ? (
            <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{repo}</a>
          ) : (
            <span className="skel" style={{ width: "50%", height: 13 }} />
          )}
          <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {src ? `${branch} @ ${shortSha(src.sha) || "unknown"}${src.path ? ` · ${git ? "checkout" : "cloned to"} ${src.path}` : ""}` : "…"}
          </span>
        </span>
      </div>
      {git ? (
        <div className="field-hint" style={{ lineHeight: 1.55 }}>
          Dockhand runs from this git checkout. Updates compare it with the newest commit on <span className="mono">{branch}</span> at GitHub; updating runs{" "}
          <span className="mono">git pull --ff-only</span> and <span className="mono">docker compose up -d --build</span> in <span className="mono">{src?.path}</span>.
        </div>
      ) : (
      <>
      <label className="field">
        Compose file
        <input
          className="input mono"
          value={composeVal}
          disabled={!u}
          placeholder="/opt/dockhand/docker-compose.yml"
          onChange={(e) => setCompose(e.target.value)}
          onBlur={() => {
            if (compose != null && u && compose.trim() !== u.composeFile) save({ updates: { composeFile: compose.trim() } }).then(() => setCompose(null));
            else setCompose(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <div className="field">
        Build strategy
        <Seg<Settings["updates"]["build"]> fit options={[{ value: "pull", label: "Pull image" }, { value: "build", label: "Build from source" }]} value={u?.build ?? "pull"} onChange={(x) => save({ updates: { build: x } })} />
        <span className="field-hint">Build compiles the image locally from source; pull uses the published image for this tag.</span>
      </div>
      </>
      )}
      <SetToggle label={`Redeploy on push to ${branch}`} sub="For running your own fork" on={!!u?.redeployOnPush} disabled={!u} onChange={(x) => save({ updates: { redeployOnPush: x } })} />
    </div>
  );
}

const HISTORY_PAGE = 5;

function HistoryCard({ sys, busy, onRollback }: { sys?: SystemInfo; busy: boolean; onRollback: () => void }) {
  const [page, setPage] = useState(1);
  const { data } = useApi<UpdateHistoryPage>(`/api/system/history?page=${page}&limit=${HISTORY_PAGE}`, { refresh: 15000 });
  const hist = data?.items ?? [];
  const pages = data?.pages ?? 1;
  // Rolling back needs a successful update with a known previous version (checked on the full, unpaged list).
  const canRollback = (sys?.history ?? []).some((h) => h.status === "success" && h.fromVersion);
  useEffect(() => {
    if (data && page > data.pages) setPage(data.pages);
  }, [data, page]);
  const isCurrent = (ver: string) =>
    !!sys && (ver === sys.version || ver.replace(/^v/, "") === sys.version.replace(/^v/, "") || (!!sys.currentCommit && ver.startsWith(sys.currentCommit)));
  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Update history">
        <InkButton onClick={onRollback} disabled={!canRollback || busy || !sys?.canSelfUpdate} title={canRollback ? "Restore the previous version" : "Nothing to roll back to"}>
          Roll back
        </InkButton>
      </InkHead>
      {!data && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 50, borderRadius: 14 }} />)}
      {data && !data.total && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No updates yet — this is the version you installed.</span>}
      {hist.map((h) => (
        <div key={h.id} style={rowStyle(true, { padding: "10px 12px" })}>
          <span className="dot" style={{ background: h.status === "success" ? C.ok : h.status === "failed" ? C.crit : h.status === "running" || h.status === "pending" ? C.blue : "var(--muted)" }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
              {v(h.version)}
              {isCurrent(h.version) && <span className="tag blue" style={{ marginLeft: 8, fontFamily: "var(--font)", fontSize: 10, padding: "2px 6px" }}>current</span>}
            </span>
            <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              {[h.fromVersion ? `from ${v(h.fromVersion)}` : "", h.note, h.status !== "success" ? h.status : ""].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }} title={new Date(h.at).toLocaleString()}>{ago(h.at)}</span>
        </div>
      ))}
      {data && pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 2 }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1 }}>
            {(page - 1) * HISTORY_PAGE + 1}–{Math.min(page * HISTORY_PAGE, data.total)} of {data.total}
          </span>
          <button type="button" className="btn2 sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Newer">
            <Icon name="chevron" size={14} style={{ transform: "rotate(90deg)" }} />
            Newer
          </button>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", minWidth: 42, textAlign: "center" }}>{page} / {pages}</span>
          <button type="button" className="btn2 sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))} aria-label="Older">
            Older
            <Icon name="chevron" size={14} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </div>
      )}
    </div>
  );
}
