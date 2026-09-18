"use client";

import useSWR, { mutate as globalMutate, type SWRConfiguration } from "swr";
import { useEffect, useState } from "react";
import type { Job } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T = unknown>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "dockhand",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
    const here = window.location.pathname;
    if (here !== "/login" && here !== "/setup") window.location.href = `/login?next=${encodeURIComponent(here + window.location.search)}`;
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const body = data as { error?: unknown } | string | undefined;
    const msg = (typeof body === "object" && body?.error ? String(body.error) : "") || res.statusText || "Request failed";
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T = unknown,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T = unknown,>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body ?? {} });
export const patch = <T = unknown,>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: body ?? {} });
export const del = <T = unknown,>(path: string) => api<T>(path, { method: "DELETE" });

/** SWR-backed GET. Pass `null` to skip. `refresh` polls in ms. */
export function useApi<T>(path: string | null, opts: { refresh?: number } & SWRConfiguration<T> = {}) {
  const { refresh, ...rest } = opts;
  return useSWR<T>(path, (p: string) => get<T>(p), {
    refreshInterval: refresh,
    revalidateOnFocus: true,
    keepPreviousData: true,
    ...rest,
  });
}

/** Revalidate every cached GET whose key starts with `prefix`. */
export function invalidate(prefix: string) {
  return globalMutate((key) => typeof key === "string" && key.startsWith(prefix));
}

/** Poll a job every 700 ms until it finishes. */
export function useJob(jobId: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    setJob(null);
    if (!jobId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await get<Job>(`/api/jobs/${jobId}`);
        if (!alive) return;
        setJob(j);
        if (j.status === "running") timer = setTimeout(tick, 700);
      } catch {
        if (alive) timer = setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId]);
  return job;
}

/** Build a ws:// or wss:// URL for an API path on the current origin. */
export function wsUrl(path: string) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // In `next dev` the page is on :3000 and WebSockets are not proxied; talk to the API directly.
  const devApi = process.env.NEXT_PUBLIC_DOCKHAND_WS_ORIGIN;
  if (devApi) return devApi.replace(/^http/, "ws") + path;
  return `${proto}//${window.location.host}${path}`;
}

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
