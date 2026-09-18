"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader, HostChips, LogBlock, useOutside } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, useApi, useJob } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import type { JobRef } from "@/lib/types";
import { Actions, Field, Group, useHosts } from "./common";

function splitTag(img: string): [string, string] {
  const s = img.trim();
  const at = s.indexOf("@");
  if (at > 0) return [s.slice(0, at), s.slice(at + 1)];
  const i = s.lastIndexOf(":");
  if (i > s.lastIndexOf("/")) return [s.slice(0, i), s.slice(i + 1)];
  return [s, ""];
}

export function PullDialog({ hostId, image: initial, onClose }: { hostId?: string; image?: string; onClose: () => void }) {
  const { toast } = useShell();
  const hosts = useHosts();
  const [i0, t0] = splitTag(initial ?? "");
  const [image, setImage] = useState(i0);
  const [tag, setTag] = useState(t0 || "latest");
  const [sel, setSel] = useState<string[] | null>(hostId ? [hostId] : null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const job = useJob(jobId);
  const notified = useRef(false);

  useEffect(() => {
    if (sel === null && hosts.length) setSel([hosts.find((h) => h.status === "online")?.id ?? hosts[0].id]);
  }, [hosts, sel]);
  const selected = sel ?? [];

  // debounce image for the tag lookup
  const [dImage, setDImage] = useState(i0);
  useEffect(() => {
    const t = setTimeout(() => setDImage(splitTag(image)[0]), 400);
    return () => clearTimeout(t);
  }, [image]);
  const tags = useApi<{ name: string; updatedAt: string | null; size: number }[]>(dImage ? `/api/images/tags?image=${encodeURIComponent(dImage)}` : null);

  const [imgPart, embeddedTag] = splitTag(image);
  const full = `${imgPart || "image"}:${embeddedTag || tag.trim() || "latest"}`;

  useEffect(() => {
    if (!job || job.status === "running" || notified.current) return;
    notified.current = true;
    invalidate("/api/hosts");
    if (job.status === "success") toast({ kind: "ok", title: `Pulled ${full}`, text: `${selected.length} host${selected.length === 1 ? "" : "s"}` });
    else toast({ kind: "error", title: `Pull of ${full} failed`, text: job.steps.find((s) => s.status === "failed")?.sub });
  }, [job, full, selected.length, toast]);

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr("");
    if (!image.trim()) return setErr("Enter an image name.");
    if (!selected.length) return setErr("Pick at least one host.");
    setBusy(true);
    try {
      const r = await post<JobRef>("/api/images/pull", { image: imgPart, tag: embeddedTag || tag.trim() || "latest", hostIds: selected });
      notified.current = false;
      setJobId(r.jobId);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const running = !!jobId && (!job || job.status === "running");
  const lines = job?.log.length ? job.log : [{ text: `Pulling ${full}…`, level: "muted" as const }];

  return (
    <Dialog onClose={onClose} width={520}>
      <DialogHeader icon="image" title="Pull an image" sub="Pre-pull to one or more hosts so deploys are instant." onClose={onClose} />
      {!jobId && (
        <form onSubmit={start} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(120px,1fr)", gap: 12 }}>
            <Field label="Image">
              <input
                className="input mono"
                autoFocus
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="nginx, ghcr.io/org/app…"
                autoCapitalize="off"
              />
            </Field>
            <Group label="Tag">
              <TagCombo value={tag} onChange={setTag} tags={tags.data ?? []} loading={tags.isLoading} />
            </Group>
          </div>
          <Group label="Hosts">
            <HostChips hosts={hosts} selected={selected} onToggle={(id) => setSel(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])} />
          </Group>
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions>
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="deploy" size={16} />}
              <span className="ellipsis" style={{ maxWidth: 260 }}>Pull {full}</span>
            </button>
          </Actions>
        </form>
      )}
      {jobId && (
        <>
          <LogBlock lines={lines} running={running} style={{ padding: "14px 16px", borderRadius: 14, fontSize: 12, lineHeight: 1.75, minHeight: 160, maxHeight: 320 }} />
          {!running && (
            <Actions>
              {job?.status === "failed" && (
                <button type="button" className="btn2 lg" onClick={() => setJobId(null)}>Back</button>
              )}
              <button type="button" className="btn" autoFocus onClick={onClose}>Done</button>
            </Actions>
          )}
          {running && (
            <Actions>
              <span style={{ fontSize: 12, color: "var(--ink-3)", marginRight: "auto" }}>You can close this — the pull keeps running.</span>
              <button type="button" className="btn2 lg" onClick={onClose}>Close</button>
            </Actions>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Tag input with a dropdown of known tags; free text allowed. */
function TagCombo({ value, onChange, tags, loading }: { value: string; onChange: (v: string) => void; tags: { name: string; updatedAt: string | null; size: number }[]; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const shown = (typed && value ? tags.filter((t) => t.name.includes(value)) : tags).slice(0, 50);
  return (
    <span ref={ref} style={{ position: "relative", display: "block" }}>
      <span className="select-btn" style={{ padding: 0, cursor: "text" }}>
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value.trim());
            setTyped(true);
            setOpen(true);
          }}
          onFocus={() => {
            setTyped(false);
            setOpen(true);
          }}
          onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}
          data-plain
          placeholder="latest"
          style={{ flex: 1, minWidth: 0, height: "100%", border: 0, background: "transparent", padding: "0 0 0 12px", font: "inherit", color: "var(--ink)", outline: "none" }}
        />
        <button type="button" tabIndex={-1} onClick={() => setOpen(!open)} style={{ border: 0, background: "transparent", height: "100%", padding: "0 12px 0 6px", display: "flex", alignItems: "center", color: "var(--ink-3)", cursor: "pointer" }} aria-label="Show tags">
          {loading ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon name="chevron" size={14} />}
        </button>
      </span>
      {open && (shown.length > 0 || !loading) && (
        <div className="menu" style={{ left: 0, right: 0, top: 44, maxHeight: 260, overflow: "auto", minWidth: 200 }}>
          {shown.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--ink-3)" }}>{value ? `Use custom tag “${value}”` : "No tags found"}</div>}
          {shown.map((t) => (
            <button
              key={t.name}
              type="button"
              className={`menu-item mono ${t.name === value ? "active" : ""}`}
              style={{ flex: "none" }}
              onClick={() => {
                onChange(t.name);
                setOpen(false);
              }}
            >
              <span className="ellipsis" style={{ flex: 1 }}>{t.name}</span>
              <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font)", whiteSpace: "nowrap" }}>{[t.size > 0 ? bytes(t.size) : "", t.updatedAt ? ago(t.updatedAt) : ""].filter(Boolean).join(" · ")}</span>
              {t.name === value && <span style={{ display: "flex", color: "var(--blue)" }}><Icon name="check" size={14} /></span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
