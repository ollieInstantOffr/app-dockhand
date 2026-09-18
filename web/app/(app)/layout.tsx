"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { useApi } from "@/lib/api";
import type { AuthState } from "@/lib/types";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, error } = useApi<AuthState>("/api/auth/state", { revalidateOnFocus: false });

  useEffect(() => {
    if (!data) return;
    if (data.setupRequired) router.replace("/setup");
    else if (!data.user) router.replace("/login");
  }, [data, router]);

  if (error) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, color: "var(--ink-2)", fontSize: 14, textAlign: "center" }}>
        Can&apos;t reach the Dockhand API.
        <br />
        {error.message}
      </div>
    );
  }
  if (!data?.user) return null;
  return <AppShell user={data.user}>{children}</AppShell>;
}
