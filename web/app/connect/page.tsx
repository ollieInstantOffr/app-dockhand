"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { Seg } from "@/components/ui";
import { errMsg, post, useApi } from "@/lib/api";
import type { AuthState } from "@/lib/types";

type RequestInfo = { clientName: string; redirectHost: string; mcpEnabled: boolean };

/** OAuth consent for MCP clients (Claude chat, Cowork, Claude Code…) reached via /oauth/authorize. */
export default function ConnectPage() {
  const router = useRouter();
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => setQuery(window.location.search.replace(/^\?/, "")), []);

  const presetError = query !== null ? new URLSearchParams(query).get("error") : null;
  const { data: state } = useApi<AuthState>("/api/auth/state", { revalidateOnFocus: false });
  const signedIn = !!state?.user;
  const { data: info, error: infoErr } = useApi<RequestInfo>(signedIn && query && !presetError ? `/api/oauth/request?${query}` : null, { revalidateOnFocus: false });
  const [scope, setScope] = useState<"read" | "full">("read");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state || query === null || presetError) return;
    if (state.setupRequired) router.replace("/setup");
    else if (!state.user) router.replace(`/login?next=${encodeURIComponent(`/connect?${query}`)}`);
  }, [state, query, presetError, router]);

  const decide = async (approve: boolean) => {
    setErr("");
    setBusy(true);
    try {
      const r = await post<{ redirect: string }>("/api/oauth/approve", { query, approve, scope, hostIds: [] });
      window.location.href = r.redirect;
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  const failure = presetError || (infoErr ? errMsg(infoErr) : "");
  return (
    <AuthCard width={440} gap={20} title="Connect to Dockhand" sub={info ? `${info.clientName} wants access` : "Authorize an MCP client"}>
      {failure ? (
        <FormError>This connection request can&apos;t be used: {failure}. Start the connection again from your MCP client.</FormError>
      ) : !info ? (
        <span style={{ fontSize: 13, color: "var(--ink-3)" }}>Loading…</span>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
            <strong>{info.clientName}</strong> will be able to use Dockhand&apos;s MCP tools on the hosts exposed to MCP. After you allow it, you&apos;ll be sent back to{" "}
            <span className="mono">{info.redirectHost}</span>. You can revoke access any time under Settings → MCP → API keys.
          </p>
          <label className="field">
            Access
            <Seg<"read" | "full"> options={[{ value: "read", label: "Read-only" }, { value: "full", label: "Full control" }]} value={scope} onChange={setScope} />
            <span className="field-hint">{scope === "read" ? "List and inspect hosts, containers, stacks and logs." : "Also start, stop, update and deploy. Tools set to confirm still ask first."}</span>
          </label>
          {!info.mcpEnabled && <FormError>The MCP server is off. Turn it on in Settings → MCP, then allow this connection.</FormError>}
          {err && <FormError>{err}</FormError>}
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn2 lg" style={{ flex: 1, height: 46, borderRadius: 14 }} disabled={busy} onClick={() => decide(false)}>
              Deny
            </button>
            <button type="button" className="btn lg" style={{ flex: 1 }} disabled={busy || !info.mcpEnabled} onClick={() => decide(true)}>
              {busy && <span className="spinner" />}
              Allow
            </button>
          </div>
        </>
      )}
    </AuthCard>
  );
}
