import type { HostInput, HostTestResult, JobStep } from "@/lib/types";

/** Connection-test steps in the order the API runs them (shown while waiting). */
export const TEST_LABELS = ["Resolving address", "Opening SSH connection", "Authenticating", "Checking Docker", "Reading host info"];

export function pendingSteps(method: HostInput["method"]): JobStep[] {
  return TEST_LABELS.map((label, i) => ({
    label,
    sub: method === "local" && i < 3 ? "skipped for local socket" : "",
    status: i === 0 ? "running" : method === "local" && i < 3 ? "skipped" : "pending",
    t: "",
  }));
}

export function resultSteps(r: HostTestResult): JobStep[] {
  return r.steps.map((s) => ({ label: s.label, sub: s.sub, status: s.status, t: s.status === "skipped" ? "" : s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms` }));
}

export interface SshConfigEntry {
  name: string;
  address: string;
  port: number;
  user: string;
}

/** Parse an ~/.ssh/config into concrete hosts. Wildcard / negated patterns are skipped. */
export function parseSshConfig(text: string): SshConfigEntry[] {
  const out: SshConfigEntry[] = [];
  let cur: { names: string[]; hostName?: string; port?: number; user?: string } | null = null;
  const flush = () => {
    if (!cur) return;
    for (const n of cur.names) {
      if (/[*?!]/.test(n)) continue;
      out.push({ name: n, address: cur.hostName || n, port: cur.port || 22, user: cur.user || "root" });
    }
    cur = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      flush();
      cur = { names: val.split(/\s+/).filter(Boolean) };
    } else if (key === "match") {
      flush();
    } else if (cur) {
      if (key === "hostname") cur.hostName = val;
      else if (key === "port") cur.port = parseInt(val, 10) || 22;
      else if (key === "user") cur.user = val;
    }
  }
  flush();
  // de-duplicate by name, first wins (ssh semantics)
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}
