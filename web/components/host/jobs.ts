"use client";

import { errMsg, get, invalidate } from "@/lib/api";
import type { Job, JobRef } from "@/lib/types";
import type { Shell } from "../shell/context";

/**
 * Toast "Started…", poll the job until it finishes, then toast the result and
 * revalidate the given API prefixes. Fire-and-forget; resolves with the job.
 */
export async function trackJob(
  shell: Pick<Shell, "toast">,
  ref: JobRef | Promise<JobRef>,
  opts: { title: string; done?: string; invalidate?: string[]; quiet?: boolean; onDone?: (j: Job) => void },
): Promise<Job | null> {
  let jobId: string;
  try {
    jobId = (await ref).jobId;
  } catch (e) {
    shell.toast({ kind: "error", title: `${opts.title} failed`, text: errMsg(e) });
    return null;
  }
  if (!opts.quiet) shell.toast({ kind: "info", title: `${opts.title}…`, text: "Running in the background — you'll get a toast when it's done." });
  const prefixes = opts.invalidate ?? ["/api/hosts"];
  let job: Job | null = null;
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, job ? 900 : 500));
    try {
      job = await get<Job>(`/api/jobs/${jobId}`);
      misses = 0;
      if (job.status !== "running") break;
    } catch {
      if (++misses > 20) break;
    }
  }
  prefixes.forEach((p) => invalidate(p));
  if (!job) {
    shell.toast({ kind: "warn", title: opts.title, text: "Lost track of the job — check the host for its result." });
    return null;
  }
  if (job.status === "success") {
    shell.toast({ kind: "ok", title: opts.done ?? `${opts.title} — done`, text: job.title });
  } else {
    const failed = job.steps.find((s) => s.status === "failed");
    const lastErr = [...job.log].reverse().find((l) => l.level === "error");
    shell.toast({ kind: "error", title: `${opts.title} failed`, text: failed?.sub || lastErr?.text || failed?.label || job.title });
  }
  opts.onDone?.(job);
  return job;
}

/** Run a plain mutation with a success toast / error toast. Returns true on success. */
export async function act<T>(shell: Pick<Shell, "toast">, fn: () => Promise<T>, ok?: { title: string; text?: string } | ((r: T) => { title: string; text?: string }), errTitle = "Something went wrong"): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) shell.toast({ kind: "ok", ...(typeof ok === "function" ? ok(r) : ok) });
    return r;
  } catch (e) {
    shell.toast({ kind: "error", title: errTitle, text: errMsg(e) });
    return undefined;
  }
}
