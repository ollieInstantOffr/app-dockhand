"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useApi } from "@/lib/api";
import type { ApiKey, Host, SystemInfo } from "@/lib/types";
import { HostsTab } from "@/components/settings/HostsTab";
import { GithubTab } from "@/components/settings/GithubTab";
import { McpTab } from "@/components/settings/McpTab";
import { UpdatesTab } from "@/components/settings/UpdatesTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";
import { AccountTab } from "@/components/settings/AccountTab";
import { SettingsStyles, useSettings } from "@/components/settings/common";

const TABS = [
  { value: "hosts", label: "Hosts", icon: "server" },
  { value: "github", label: "GitHub", icon: "branch" },
  { value: "mcp", label: "MCP", icon: "mcp" },
  { value: "updates", label: "Updates", icon: "update" },
  { value: "notifications", label: "Notifications", icon: "bell" },
  { value: "account", label: "Account", icon: "user" },
] as const satisfies readonly { value: string; label: string; icon: IconName }[];

type Tab = (typeof TABS)[number]["value"];

const ver = (s: string) => (s ? `v${s.replace(/^v/, "")}` : "");

export default function SettingsPage() {
  const router = useRouter();
  const params = useParams<{ tab: string }>();
  const raw = params?.tab ?? "hosts";
  const valid = TABS.some((t) => t.value === raw);
  const tab = (valid ? raw : "hosts") as Tab;

  useEffect(() => {
    if (!valid) router.replace("/settings/hosts");
  }, [valid, router]);

  return (
    <section style={{ animation: "rise .4s ease both", display: "flex", flexDirection: "column", gap: 20, maxWidth: 1040 }}>
      <SettingsStyles />
      <PageHeader title="Settings" sub="Hosts, integrations, notifications and your account." />
      <div className="set-layout">
        <SettingsNav tab={tab} />
        <div className="set-content">
          {tab === "hosts" && <HostsTab />}
          {tab === "github" && <GithubTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "updates" && <UpdatesTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "account" && <AccountTab />}
        </div>
      </div>
    </section>
  );
}

function SettingsNav({ tab }: { tab: Tab }) {
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  const { data: sys } = useApi<SystemInfo>("/api/system");
  const { settings } = useSettings();
  const mcpOn = !!settings?.mcp.enabled;
  const { data: keys } = useApi<ApiKey[]>(mcpOn ? "/api/mcp/keys" : null);
  const liveKeys = keys?.filter((k) => !k.revoked).length ?? 0;

  const badge = (t: Tab): { text: string; warn?: boolean } | null => {
    if (t === "hosts" && hosts?.length) return { text: String(hosts.length) };
    if (t === "mcp" && mcpOn && liveKeys) return { text: String(liveKeys) };
    if (t === "updates" && sys?.updateAvailable) return { text: "1", warn: true };
    return null;
  };

  return (
    <nav className="set-nav" aria-label="Settings">
      <div className="set-nav-items">
        {TABS.map((t) => {
          const b = badge(t.value);
          const on = t.value === tab;
          return (
            <Link key={t.value} href={`/settings/${t.value}`} scroll={false} className={`set-nav-item ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>
              <span className="set-nav-ic">
                <Icon name={t.icon} size={17} />
              </span>
              <span className="set-nav-label">{t.label}</span>
              {b && (
                <span className={`set-nav-badge ${b.warn ? "warn" : ""}`} title={t.value === "updates" ? "Update available" : undefined}>
                  {b.text}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      <span className="set-nav-div" />
      <Link href="/settings/updates" scroll={false} className="set-nav-foot" title={sys?.updateAvailable ? `${ver(sys.latest)} is available` : undefined}>
        <span style={{ fontSize: 11, opacity: 0.55 }}>Dockhand</span>
        <span className="mono" style={{ fontSize: 12, opacity: 0.8 }}>
          {sys ? `${ver(sys.version)} · ${sys.updateAvailable ? "update available" : "up to date"}` : "…"}
        </span>
      </Link>
    </nav>
  );
}
