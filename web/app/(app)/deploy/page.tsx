"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useApi } from "@/lib/api";
import { ago } from "@/lib/format";
import type { GitAccount } from "@/lib/types";
import { DeployStyles } from "@/components/deploy/shared";
import { GitFlow } from "@/components/deploy/GitFlow";
import { ImageFlow } from "@/components/deploy/ImageFlow";
import { ComposeFlow } from "@/components/deploy/ComposeFlow";

type Mode = "git" | "image" | "compose";

const SUBS: Record<Mode, string> = {
  git: "Pick a repo with a compose file — Dockhand clones it and brings it up on any host.",
  image: "Run any image from Docker Hub, GHCR or your own registry as a single container.",
  compose: "Write or paste a compose file and run it as a managed stack.",
};

export default function DeployPage() {
  return (
    <Suspense fallback={null}>
      <Deploy />
    </Suspense>
  );
}

function Deploy() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const q = params.get("mode");
  const [mode, setMode] = useState<Mode>(q === "image" || q === "compose" ? q : "git");
  const hostParam = params.get("host") ?? "";
  const imageParam = params.get("image") ?? "";
  const [host, setHost] = useState(hostParam);
  const [nonce, setNonce] = useState(0);
  // Arriving again with a different ?mode / ?host (e.g. from the "+" menu while already here) restarts the flow.
  const lastParams = useRef(`${q}|${hostParam}|${imageParam}`);
  useEffect(() => {
    const key = `${q}|${hostParam}|${imageParam}`;
    if (key === lastParams.current) return;
    lastParams.current = key;
    if (q === "image" || q === "compose" || q === "git") setMode(q);
    setHost(hostParam);
    setNonce((n) => n + 1);
  }, [q, hostParam, imageParam]);
  const accounts = useApi<GitAccount[]>("/api/github/accounts");
  const acct = accounts.data?.find((a) => a.enabled) ?? accounts.data?.[0];
  const others = (accounts.data?.length ?? 0) - 1;
  const repoTotal = accounts.data?.reduce((n, a) => n + a.repoCount, 0) ?? 0;
  const syncing = accounts.data?.some((a) => a.status === "syncing");

  const switchMode = (m: Mode) => {
    if (m === mode) setNonce((n) => n + 1); // clicking the active tab restarts the flow
    setMode(m);
    const sp = new URLSearchParams(params.toString());
    sp.set("mode", m);
    lastParams.current = `${m}|${hostParam}|${imageParam}`; // our own URL change — don't restart twice
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  return (
    <section style={{ animation: "rise .4s ease both", maxWidth: 1100, display: "flex", flexDirection: "column", gap: 20 }}>
      <DeployStyles />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 className="page-title">Deploy</h1>
          <p className="page-sub">{SUBS[mode]}</p>
        </div>
        {acct && (
          <div className="glass-chip" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px 8px 8px", borderRadius: 14, fontSize: 13 }}>
            <span style={{ width: 28, height: 28, borderRadius: 9, background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center" }}>
              <Icon name="branch" size={15} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontWeight: 700 }}>
                @{acct.login}
                {others > 0 && <span style={{ fontWeight: 600, color: "var(--ink-3)" }}> +{others}</span>}
              </span>
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {repoTotal} repos · {syncing ? "syncing…" : `synced ${ago(acct.lastSyncAt)}`}
              </span>
            </span>
          </div>
        )}
      </div>

      <Tabs<Mode>
        value={mode}
        onChange={switchMode}
        items={[
          { value: "git", label: "From GitHub" },
          { value: "image", label: "Docker image" },
          { value: "compose", label: "Compose file" },
        ]}
      />

      {mode === "git" && <GitFlow key={`git${nonce}`} initialHost={host} />}
      {mode === "image" && <ImageFlow key={`image${nonce}`} initialHost={host} initialImage={imageParam} />}
      {mode === "compose" && <ComposeFlow key={`compose${nonce}`} initialHost={host} />}
    </section>
  );
}
