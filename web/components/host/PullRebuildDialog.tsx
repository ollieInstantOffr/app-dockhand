"use client";

import { useEffect, useState } from "react";
import { errMsg, invalidate, post, useApi, useJob } from "@/lib/api";
import { C, ago, plural, shortSha } from "@/lib/format";
import type { Impact, JobRef, StackGitStatus } from "@/lib/types";
import { Dialog, DialogHeader, ToggleRow } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { trackJob } from "./jobs";
import { JobProgress } from "@/components/jobs/JobProgress";

/**
 * Pull & rebuild: git pull + docker compose up -d --build for a stack that
 * came from git — deployed by Dockhand from GitHub, or cloned onto the host.
 * Shows the commits you're about to get before anything changes.
 */
export function PullRebuildDialog({ hostId, stack, onClose, jobId: startJob }: { hostId: string; stack: string; onClose: () => void; jobId?: string }) {
  const shell = useShell();
  const base = `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}`;
  // Once started, the dialog follows the job instead of closing.
  const [jobId, setJobId] = useState<string | null>(startJob ?? null);
  const job = useJob(jobId);
  const [startErr, setStartErr] = useState("");
  const [starting, setStarting] = useState(false);
  const { data: st, error } = useApi<StackGitStatus>(jobId ? null : `${base}/git`, { revalidateOnFocus: false });
  const { data: blast } = useApi<Impact>(jobId ? null : `${base}/impact?action=down`, { revalidateOnFocus: false });
  const inv = [`/api/hosts/${hostId}`, "/api/containers", "/api/overview", "/api/jobs"];
  const finished = job && job.status !== "running";
  useEffect(() => {
    if (finished) inv.forEach((p) => invalidate(p));
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const [force, setForce] = useState(false);
  const [pullImages, setPullImages] = useState(false);
  const [noCache, setNoCache] = useState(false);

  const upToDate = st && st.current && st.latest && st.current === st.latest;
  const dirtyBlocks = st?.kind === "checkout" && st.dirty > 0 && !force;
  const aheadBlocks = st?.kind === "checkout" && st.ahead > 0 && !force;

  const go = async () => {
    setStartErr("");
    setStarting(true);
    try {
      const r = await post<JobRef>(`${base}/pull-rebuild`, { force, pullImages, noCache });
      setJobId(r.jobId);
      invalidate("/api/jobs");
    } catch (e) {
      setStartErr(errMsg(e));
    } finally {
      setStarting(false);
    }
  };

  // Closing mid-run keeps it going; a toast says when it's done.
  const close = () => {
    if (jobId && job?.status === "running") {
      trackJob(shell, { jobId }, { title: `Pull & rebuild ${stack}`, done: `${stack} rebuilt`, invalidate: inv, quiet: true });
    }
    onClose();
  };

  if (jobId) {
    const sha = typeof job?.result?.sha === "string" ? (job.result.sha as string) : "";
    return (
      <Dialog onClose={close} width={600}>
        <DialogHeader icon="branch" title={`Pull & rebuild ${stack}`} sub={job?.status === "running" || !job ? "Running — you can close this, it keeps going" : job.status === "success" ? "Finished" : "Stopped with an error"} onClose={close} />
        {!job ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 14, background: "var(--fill-1)", fontSize: 13, color: "var(--ink-2)" }}>
            <span className="spinner" style={{ width: 14, height: 14 }} />
            Starting…
          </div>
        ) : (
          <JobProgress job={job} doneText={sha ? `${stack} is now at ${shortSha(sha)}` : `${stack} rebuilt`} failedText="Pull & rebuild failed" />
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {job?.status === "failed" && (
            <button type="button" className="btn2 lg" onClick={() => setJobId(null)}>
              Try again
            </button>
          )}
          <button type="button" className={job?.status === "running" || !job ? "btn2 lg" : "btn"} onClick={close}>
            {job?.status === "running" || !job ? "Run in background" : "Close"}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog onClose={onClose} width={600}>
      <DialogHeader icon="branch" title={`Pull & rebuild ${stack}`} sub="git pull, then docker compose up -d --build" onClose={onClose} />

      {!st && !error && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 14, background: "var(--fill-1)", fontSize: 13, color: "var(--ink-2)" }}>
          <span className="spinner" style={{ width: 14, height: 14 }} />
          Checking the branch for new commits…
        </div>
      )}
      {error && <span style={{ fontSize: 13, color: "var(--crit-ink)" }}>{error.message}</span>}

      {st?.kind === "none" && (
        <div style={{ padding: "14px 16px", borderRadius: 14, background: "var(--fill-1)", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
          {st.error ? (
            st.error
          ) : (
            <>
              This stack wasn&apos;t deployed from GitHub, and its folder <span className="mono">{st.path || "(unknown)"}</span> isn&apos;t a git checkout — there&apos;s nothing to pull. Use <b>Edit compose</b> or <b>Deploy</b> instead.
            </>
          )}
        </div>
      )}

      {st && st.kind !== "none" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", flexWrap: "wrap" }}>
            <span style={{ width: 32, height: 32, borderRadius: 10, background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
              <Icon name="branch" size={15} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
              <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 700 }}>
                {st.repo || "origin"}@{st.branch}
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                {shortSha(st.current) || "?"} → {shortSha(st.latest) || "?"} · {st.kind === "managed" ? "fetched from GitHub by Dockhand" : `git checkout at ${st.path}`}
              </span>
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: upToDate ? C.ok : C.blue, whiteSpace: "nowrap" }}>
              {upToDate ? "up to date" : st.behind > 0 ? `${plural(st.behind, "new commit")}` : st.behind < 0 ? "new commits" : ""}
            </span>
          </div>

          {st.error && <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--warn-bg)", border: "1px solid rgba(224,160,32,.3)", fontSize: 12.5, color: "var(--warn-ink)", lineHeight: 1.5 }}>{st.error}</div>}

          {st.commits.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="section-label">What you&apos;ll get</span>
              <div style={{ display: "flex", flexDirection: "column", borderRadius: 14, border: "1px solid var(--line-1)", overflow: "hidden", maxHeight: 220, overflowY: "auto" }}>
                {st.commits.map((c) => (
                  <div key={c.sha} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: "1px solid var(--line-1)", fontSize: 12.5 }}>
                    <span className="mono" style={{ color: "var(--ink-3)", flex: "none" }}>{shortSha(c.sha)}</span>
                    <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{c.message}</span>
                    <span style={{ color: "var(--ink-3)", whiteSpace: "nowrap", flex: "none" }}>{c.author}{c.date ? ` · ${ago(c.date)}` : ""}</span>
                  </div>
                ))}
              </div>
              {st.compareUrl && (
                <a href={st.compareUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, alignSelf: "flex-start" }}>
                  See the full diff ↗
                </a>
              )}
            </div>
          )}

          {st.kind === "checkout" && (st.dirty > 0 || st.ahead > 0) && (
            <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)", lineHeight: 1.5 }}>
              {st.dirty > 0 && <>{plural(st.dirty, "tracked file")} {st.dirty === 1 ? "was" : "were"} changed on the host. </>}
              {st.ahead > 0 && <>The host has {plural(st.ahead, "local commit")} the remote doesn&apos;t. </>}
              Pulling needs <b>Discard local changes</b>, which resets the checkout to the remote branch. Untracked files (data folders, .env) are kept.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)" }}>
            {st.kind === "checkout" && <ToggleRow label="Discard local changes" sub="git reset --hard to the remote branch (a forced pull)" on={force} onChange={setForce} />}
            <ToggleRow label="Pull newer base images" sub="docker compose build --pull, and up --pull always" on={pullImages} onChange={setPullImages} />
            <ToggleRow label="Rebuild without cache" sub="Slower; use when a build step fetches something that changed" on={noCache} onChange={setNoCache} />
          </div>

          {blast && blast.stops.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)" }}>
              <Icon name="alert" size={14} color={C.warn} />
              Services whose image changes are recreated — up to {plural(blast.stops.length, "container")}
              {blast.monitors.length ? `, watched by ${plural(blast.monitors.length, "uptime check")}` : ""}.
            </span>
          )}
        </>
      )}

      {startErr && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{startErr}</span>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn2 lg" onClick={onClose}>
          Cancel
        </button>
        {st && st.kind !== "none" && (
          <button type="button" className="btn" onClick={go} disabled={dirtyBlocks || aheadBlocks || starting}>
            {starting ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name="update" size={15} />}
            {upToDate ? "Rebuild" : "Pull & rebuild"}
          </button>
        )}
      </div>
    </Dialog>
  );
}
