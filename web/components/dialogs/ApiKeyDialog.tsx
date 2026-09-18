"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogHeader, Dropdown, HostChips, Seg, Stepper, copyText } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post } from "@/lib/api";
import type { ApiKey, ApiKeyInput } from "@/lib/types";
import { Actions, Field, Group, useHosts } from "./common";

const GROUPS = ["Hosts", "Containers", "Logs", "Stacks", "Images", "Deploy"];
type Expiry = "0" | "30" | "90" | "365";

export function ApiKeyDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useShell();
  const hosts = useHosts();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [client, setClient] = useState<ApiKey["client"]>("claude");
  const [scope, setScope] = useState<ApiKey["scope"]>("read");
  const [groups, setGroups] = useState<string[]>(["Hosts", "Containers", "Logs"]);
  const [hostIds, setHostIds] = useState<string[] | null>(null); // null = not initialised (all)
  const [expires, setExpires] = useState<Expiry>("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [key, setKey] = useState("");

  useEffect(() => {
    if (hostIds === null && hosts.length) setHostIds(hosts.map((h) => h.id));
  }, [hosts, hostIds]);
  const selected = hostIds ?? hosts.map((h) => h.id);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!name.trim()) return setErr("Give the key a name, e.g. the client and machine it lives on.");
    setStep(1);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (scope === "custom" && !groups.length) return setErr("Pick at least one tool group.");
    if (hosts.length && !selected.length) return setErr("Pick at least one host.");
    setBusy(true);
    try {
      const all = hosts.length > 0 && selected.length === hosts.length;
      const body: ApiKeyInput = {
        name: name.trim(),
        client,
        scope,
        groups: scope === "custom" ? groups : [],
        hostIds: all ? [] : selected,
        expiresDays: parseInt(expires, 10),
      };
      const r = await post<ApiKey & { key: string }>("/api/mcp/keys", body);
      setKey(r.key);
      setStep(2);
      invalidate("/api/mcp");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width={500}>
      <DialogHeader icon="key" title="New MCP API key" sub="One key per client, scoped to exactly what it may do." onClose={onClose} />
      <Stepper steps={["Name", "Scope", "Key"]} current={step} />

      {step === 0 && (
        <form onSubmit={next} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Key name">
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Desktop · MacBook" />
          </Field>
          <Group label="Client">
            <Seg<ApiKey["client"]>
              value={client}
              onChange={setClient}
              options={[
                { value: "claude", label: "Claude" },
                { value: "cursor", label: "Cursor" },
                { value: "other", label: "Other" },
              ]}
            />
          </Group>
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions style={{ marginTop: 4 }}>
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn">Continue</button>
          </Actions>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Group label="Permissions">
            <Seg<ApiKey["scope"]>
              value={scope}
              onChange={setScope}
              options={[
                { value: "read", label: "Read-only" },
                { value: "full", label: "Full control" },
                { value: "custom", label: "Custom" },
              ]}
            />
            <span className="field-hint">
              {scope === "read" ? "List and inspect hosts, containers, stacks and logs. No changes." : scope === "full" ? "Everything, including restarts, deploys and removals. Confirm-gated tools still ask." : "Only the tool groups selected below."}
            </span>
          </Group>
          {scope === "custom" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", animation: "rise .2s ease both" }}>
              {GROUPS.map((g) => (
                <button key={g} type="button" className={`choice ${groups.includes(g) ? "on" : ""}`} onClick={() => setGroups((cur) => toggle(cur, g))} style={{ height: 32, padding: "0 12px", borderRadius: 10, fontSize: 12.5, fontWeight: 600 }}>
                  {g}
                </button>
              ))}
            </div>
          )}
          <Group label="Hosts">
            {hosts.length ? <HostChips hosts={hosts} selected={selected} onToggle={(id) => setHostIds(toggle(selected, id))} /> : <span className="field-hint">No hosts yet — the key will cover every host you add.</span>}
          </Group>
          <Group label="Expires">
            <Dropdown<Expiry>
              value={expires}
              onChange={setExpires}
              options={[
                { value: "0", label: "Never" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
              ]}
            />
          </Group>
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions style={{ marginTop: 4 }}>
            <button type="button" className="btn2 lg" onClick={() => setStep(0)}>Back</button>
            <button type="submit" className="btn" disabled={busy}>
              {busy && <span className="spinner" />}
              Create key
            </button>
          </Actions>
        </form>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, borderRadius: 14, background: "rgba(20,23,31,.94)", fontSize: 12.5, color: "#9fd18b", wordBreak: "break-all" }}>
            <span style={{ flex: 1, userSelect: "all" }}>{key}</span>
            <button
              type="button"
              onClick={() => {
                copyText(key);
                toast({ kind: "ok", title: "Key copied" });
              }}
              style={{ height: 30, padding: "0 10px", borderRadius: 9, border: 0, background: "rgba(255,255,255,.12)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: "none", fontFamily: "var(--font)" }}
            >
              <Icon name="copy" size={13} />
              Copy
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "var(--warn-bg)", fontSize: 12.5, color: "var(--warn-ink)", lineHeight: 1.5 }}>
            <Icon name="alert" size={16} />
            This is the only time the full key is shown. Store it in your client now.
          </div>
          <Actions>
            <button
              type="button"
              className="btn"
              autoFocus
              onClick={() => {
                invalidate("/api/mcp");
                onClose();
              }}
            >
              Done
            </button>
          </Actions>
        </div>
      )}
    </Dialog>
  );
}
