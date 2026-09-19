// Ad-hoc SSH logins to addresses that aren't Dockhand hosts.
// Recent connections and remembered host keys live in this browser only;
// passwords and private keys are never stored.

export type SshAuth = "key" | "password" | "privateKey";

export interface CustomSshConn {
  address: string;
  port: number;
  user: string;
  auth: SshAuth;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export type SshRecent = Pick<CustomSshConn, "address" | "port" | "user" | "auth">;

const RECENT = "dockhand.ssh.recent";
const KNOWN = "dockhand.ssh.known";

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export const sshDest = (c: Pick<CustomSshConn, "address" | "port" | "user">) => `${c.user}@${c.address}${c.port && c.port !== 22 ? `:${c.port}` : ""}`;
export const sshCommand = (c: Pick<CustomSshConn, "address" | "port" | "user">) => `ssh ${c.user}@${c.address}${c.port && c.port !== 22 ? ` -p ${c.port}` : ""}`;
const knownKey = (c: Pick<CustomSshConn, "address" | "port">) => `${c.address.toLowerCase()}:${c.port || 22}`;

export function recentSsh(): SshRecent[] {
  return read<SshRecent[]>(RECENT, []);
}

export function rememberSsh(c: CustomSshConn) {
  const r: SshRecent = { address: c.address, port: c.port, user: c.user, auth: c.auth };
  const list = recentSsh().filter((x) => sshDest(x) !== sshDest(r));
  write(RECENT, [r, ...list].slice(0, 8));
}

export function forgetRecentSsh(r: SshRecent) {
  write(RECENT, recentSsh().filter((x) => sshDest(x) !== sshDest(r)));
}

export function knownHostKey(c: Pick<CustomSshConn, "address" | "port">): string {
  return read<Record<string, string>>(KNOWN, {})[knownKey(c)] ?? "";
}

export function saveHostKey(c: Pick<CustomSshConn, "address" | "port">, fingerprint: string) {
  const all = read<Record<string, string>>(KNOWN, {});
  all[knownKey(c)] = fingerprint;
  write(KNOWN, all);
}

export function forgetHostKey(c: Pick<CustomSshConn, "address" | "port">) {
  const all = read<Record<string, string>>(KNOWN, {});
  delete all[knownKey(c)];
  write(KNOWN, all);
}

/** Parses "user@host:port", "user@host", "host:port" or "ssh user@host -p 2222". */
export function parseDest(s: string): Partial<Pick<CustomSshConn, "address" | "port" | "user">> {
  let v = s.trim().replace(/^ssh\s+/, "");
  const out: Partial<Pick<CustomSshConn, "address" | "port" | "user">> = {};
  const p = v.match(/\s-p\s*(\d+)/);
  if (p) {
    out.port = Number(p[1]);
    v = v.replace(p[0], "").trim();
  }
  const at = v.lastIndexOf("@");
  if (at > 0) {
    out.user = v.slice(0, at);
    v = v.slice(at + 1);
  }
  const m = v.match(/^\[(.+)\]:(\d+)$/) ?? v.match(/^([^:]+):(\d+)$/);
  if (m) {
    out.address = m[1];
    out.port = Number(m[2]);
  } else out.address = v.replace(/^\[|\]$/g, "");
  return out;
}
