// Dockhand API contract. The Go API (server/) serialises exactly these shapes
// as JSON (camelCase). Timestamps are RFC 3339 strings, sizes are bytes,
// percentages are 0–100 numbers. See docs/API.md for the endpoint list.

export type ID = string;
export type ISODate = string;

// ─── Auth / account ────────────────────────────────────────────────────────

export type Theme = "light" | "dark" | "system";

export interface User {
  id: ID;
  name: string;
  username: string;
  role: string;
  theme: Theme;
  createdAt: ISODate;
}

export interface AuthState {
  setupRequired: boolean; // no users exist yet → onboarding
  user: User | null;
  version: string;
}

export interface SessionInfo {
  id: ID;
  device: string; // "Safari · macOS", parsed from the user agent
  ip: string;
  createdAt: ISODate;
  lastSeenAt: ISODate;
  current: boolean;
}

export interface Account {
  user: User;
  sessions: SessionInfo[];
}

export interface SshKeyInfo {
  publicKey: string; // full "ssh-ed25519 AAAA… dockhand"
  fingerprint: string; // SHA256:…
}

// ─── Hosts ─────────────────────────────────────────────────────────────────

export type HostStatus = "pending" | "online" | "degraded" | "offline";
export type HostMethod = "key" | "password" | "local";

export interface Host {
  id: ID;
  name: string;
  address: string;
  port: number;
  user: string;
  method: HostMethod;
  color: string; // avatar background, e.g. "#2f6fed" or a CSS gradient
  status: HostStatus;
  os: string; // "Ubuntu 24.04"
  kernel: string;
  dockerVersion: string;
  cpuCores: number;
  uptimeSec: number;
  cpu: number; // %
  mem: number; // %
  disk: number; // %
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  running: number; // running containers
  total: number; // all containers
  updates: number; // containers with an image update available
  spark: number[]; // last 20 CPU samples (%), oldest first
  lastSeenAt: ISODate | null;
  lastError: string;
  failCount: number;
  monitored: boolean;
  mcpExposed: boolean;
  createdAt: ISODate;
}

export interface HostInput {
  name: string;
  address: string;
  port: number;
  user: string;
  method: HostMethod;
  password?: string;
  color?: string;
}

export interface TestStep {
  label: string; // "Resolving address"
  sub: string; // "10.0.0.12 → 22/tcp open"
  status: "done" | "failed" | "skipped";
  ms: number;
}

export interface HostTestResult {
  ok: boolean;
  steps: TestStep[];
  error: string;
  host?: Host; // refreshed host after a successful test
}

// ─── Containers ────────────────────────────────────────────────────────────

export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing";
export type Health = "healthy" | "unhealthy" | "starting" | "none";

export interface PortMap {
  ip: string;
  host: number; // 0 when not published
  container: number;
  proto: "tcp" | "udp";
}

export interface Container {
  id: string; // full id
  shortId: string; // 12 chars
  hostId: ID;
  name: string;
  image: string; // "ghcr.io/org/app:1.2.3"
  imageId: string;
  state: ContainerState;
  status: string; // docker's human status, "Up 3 days (healthy)"
  health: Health;
  exitCode: number;
  stack: string; // compose project label or ""
  service: string; // compose service label or ""
  cpu: number; // %
  memUsed: number;
  memLimit: number;
  ports: PortMap[];
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
  update: { available: boolean; tag: string; checkedAt: ISODate | null };
}

export interface KV {
  k: string;
  v: string;
}

export interface EnvVar extends KV {
  secret: boolean; // name looks like a secret (PASSWORD, TOKEN, KEY, SECRET…)
}

export interface Mount {
  type: "bind" | "volume" | "tmpfs" | string;
  src: string; // host path or volume name
  dst: string;
  mode: "rw" | "ro";
}

export interface ContainerNetwork {
  name: string;
  ip: string;
  gw: string;
  driver: string;
}

export interface ContainerEvent {
  t: ISODate;
  action: string; // "start", "die (exit 137)", "health_status: healthy", "restart"
  by: string; // "docker", "robin", "mcp:Claude Desktop", "auto-deploy"
}

export interface ContainerDetail extends Container {
  command: string;
  entrypoint: string;
  workdir: string;
  hostname: string;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  restartCount: number;
  env: EnvVar[];
  labels: KV[];
  mounts: Mount[];
  networks: ContainerNetwork[];
  healthCmd: string; // "" when no healthcheck
  healthInterval: string; // "30s"
  history: { cpu: number[]; mem: number[]; netRx: number[]; netTx: number[] }; // last 24 samples; mem in bytes, net in bytes/s
  events: ContainerEvent[];
}

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "kill" | "update";

export interface RunContainerInput {
  hostId: ID;
  image: string; // with tag
  name: string;
  restart: "no" | "always" | "unless-stopped" | "on-failure";
  ports: { host: string; container: string }[];
  volumes: { src: string; dst: string }[];
  env: KV[];
  network: string; // "bridge" | "host" | custom network name
  traefik: boolean; // add traefik labels for <name>.<domain>
}

// ─── Stacks ────────────────────────────────────────────────────────────────

export interface StackService {
  name: string;
  image: string;
  state: ContainerState | "missing";
  containerId: string;
  ports: PortMap[];
  health: Health;
}

export interface Stack {
  id: ID | null; // null for unmanaged (discovered) stacks
  hostId: ID;
  name: string;
  path: string; // working dir on the host
  composeFile: string; // absolute path
  status: "running" | "partial" | "stopped";
  managed: boolean;
  source: "manual" | "git" | "image" | "discovered";
  repo: string; // "robin/paperless" or ""
  branch: string;
  sha: string; // short sha
  autoDeploy: boolean;
  lastDeployAt: ISODate | null;
  services: StackService[];
}

export interface ComposeValidation {
  ok: boolean;
  error: string;
  line: number; // 0 when unknown
  services: { name: string; image: string; ports: string[] }[];
}

// ─── Storage / networks ────────────────────────────────────────────────────

export interface Image {
  id: string; // sha256:…
  shortId: string;
  repo: string; // "<none>" for dangling
  tag: string;
  size: number;
  createdAt: ISODate;
  containers: number; // using this image
  dangling: boolean;
}

export interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  size: number; // -1 if unknown
  containers: string[]; // names
  createdAt: ISODate | null;
}

export interface NetworkMember {
  id: string;
  name: string;
  ip: string;
  state: ContainerState;
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  scope: string;
  subnet: string;
  gateway: string;
  internal: boolean;
  attachable: boolean;
  system: boolean; // bridge, host, none
  members: NetworkMember[];
  createdAt: ISODate | null;
}

export interface NetworkInput {
  name: string;
  driver: "bridge" | "overlay" | "macvlan" | "ipvlan";
  subnet: string;
  gateway: string;
  internal: boolean;
  attachable: boolean;
}

// ─── Jobs (deploys, pulls, updates, backups) ───────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobStep {
  label: string;
  sub: string;
  status: StepStatus;
  t: string; // elapsed, e.g. "2.4s"
}

export interface JobLogLine {
  text: string;
  level: "info" | "ok" | "warn" | "error" | "cmd" | "muted";
}

export interface Job {
  id: ID;
  kind: "git" | "image" | "compose" | "pull" | "update" | "backup" | "stack" | "self-update" | "prune";
  title: string;
  hostId: ID | null;
  status: "running" | "success" | "failed";
  steps: JobStep[];
  log: JobLogLine[];
  result: Record<string, unknown>; // e.g. { stack: "paperless", hostId, containerId }
  startedAt: ISODate;
  finishedAt: ISODate | null;
}

export interface JobRef {
  jobId: ID;
}

// ─── GitHub ────────────────────────────────────────────────────────────────

export interface GitAccount {
  id: ID;
  login: string;
  kind: "user" | "org" | "enterprise";
  method: "app" | "oauth" | "pat";
  serverUrl: string;
  enabled: boolean;
  repoAccess: "all" | "selected";
  selectedRepos: string[]; // full names
  webhook: boolean;
  color: string;
  repoCount: number;
  composeRepoCount: number;
  lastSyncAt: ISODate | null;
  lastError: string;
  status: "ok" | "error" | "syncing";
}

export interface GitAccountInput {
  kind: "user" | "org" | "enterprise";
  method: "app" | "oauth" | "pat";
  token?: string; // pat
  serverUrl?: string; // enterprise
  deviceCode?: string; // oauth device-flow completion
  installationId?: number; // app
}

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface Repo {
  id: number;
  accountId: ID;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  composeFiles: string[];
  pushedAt: ISODate | null;
  deployedOn: string; // host name or ""
}

export interface Branch {
  name: string;
  sha: string;
  updatedAt: ISODate | null;
  isDefault: boolean;
}

export interface RepoInspect {
  composeFiles: string[];
  services: { name: string; image: string; meta: string }[]; // meta: "8000/tcp · 2 vols"
  env: { k: string; v: string; required: boolean; comment: string }[]; // from .env.example
}

export interface GitDeployInput {
  accountId: ID;
  owner: string;
  name: string;
  branch: string;
  composeFile: string;
  hostId: ID;
  path: string; // clone path on host
  env: KV[];
  autoDeploy: boolean;
}

// ─── Uptime ────────────────────────────────────────────────────────────────

export type UpStatus = "up" | "degraded" | "down" | "unknown" | "paused";
export type UpWindow = "24h" | "7d" | "30d";

export interface UptimeBar {
  status: UpStatus | "none"; // none = no data in bucket
  pct: number; // uptime % in bucket
  from: ISODate;
  to: ISODate;
}

export interface MonitorView {
  id: ID;
  name: string;
  type: "host" | "docker" | "http" | "tcp";
  hostId: ID | null;
  hostName: string;
  target: string;
  enabled: boolean;
  auto: boolean;
  status: UpStatus;
  pct: number; // uptime % over the window (-1 = no data)
  latencyMs: number; // avg over window
  incidents: number; // in window
  lastCheckAt: ISODate | null;
  bars: UptimeBar[]; // 30 buckets, oldest first
}

export interface IncidentView {
  id: ID;
  monitorId: ID;
  target: string; // monitor name (+ host)
  status: "down" | "degraded";
  message: string;
  startedAt: ISODate;
  endedAt: ISODate | null;
  durationSec: number;
}

export interface UptimeOverview {
  window: UpWindow;
  stats: {
    overall: number; // %
    monitorsUp: number;
    monitorsTotal: number;
    avgLatencyMs: number;
    incidents: number;
    openIncidents: number;
  };
  hosts: MonitorView[]; // type=host
  monitors: MonitorView[]; // docker/http/tcp
  incidents: IncidentView[]; // last 30 days, newest first
}

export interface MonitorInput {
  name: string;
  type: "docker" | "http" | "tcp";
  hostId: ID | null;
  target: string;
  expect?: string;
}

// ─── Alerts & notifications ────────────────────────────────────────────────

export type Severity = "crit" | "warn" | "info" | "ok";

export interface Alert {
  id: ID;
  severity: Severity;
  kind: string;
  title: string;
  text: string;
  hostId: ID | null;
  hostName: string;
  action: string; // button label, e.g. "Open logs"
  href: string; // in-app route the action navigates to
  createdAt: ISODate;
  read: boolean;
  snoozedUntil: ISODate | null;
  resolved: boolean;
}

export interface NotificationChannel {
  id: ID;
  type: "email" | "slack" | "ntfy" | "webhook";
  name: string;
  config: Record<string, string>; // secrets are returned masked
  enabled: boolean;
  createdAt: ISODate;
}

// ─── MCP ───────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string; // "list_containers"
  group: "Hosts" | "Containers" | "Stacks" | "Images" | "Logs" | "Deploy";
  desc: string;
  writes: boolean;
}

export interface ApiKey {
  id: ID;
  name: string;
  client: "claude" | "cursor" | "other";
  prefix: string;
  scope: "read" | "full" | "custom";
  groups: string[];
  hostIds: ID[];
  expiresAt: ISODate | null;
  lastUsedAt: ISODate | null;
  revoked: boolean;
  createdAt: ISODate;
}

export interface ApiKeyInput {
  name: string;
  client: ApiKey["client"];
  scope: ApiKey["scope"];
  groups: string[];
  hostIds: ID[];
  expiresDays: number; // 0 = never
}

export interface McpActivity {
  id: number;
  client: string; // key name
  tool: string;
  detail: string;
  ok: boolean;
  at: ISODate;
}

export interface McpStatus {
  /** Port docker-compose publishes for MCP (DOCKHAND_MCP_PORT); 0 = none. */
  publishedPort?: number;
  url: string; // full endpoint URL, e.g. https://dockhand.local/mcp
  callsToday: number;
  tools: McpTool[];
  port: number; // dedicated listener port, 0 = Dockhand's own port
  listenError?: string; // set when the dedicated listener couldn't bind
}

// ─── Settings ──────────────────────────────────────────────────────────────

export interface Settings {
  general: { publicUrl: string; domain: string }; // domain used for traefik labels
  uptime: {
    intervalSec: 30 | 60 | 300;
    retries: 1 | 2 | 3;
    hostIds: ID[]; // hosts monitored for reachability ([] = all)
    autoMonitor: boolean;
    notify: boolean;
    publicStatus: boolean;
  };
  github: {
    autoDeploy: boolean;
    waitChecks: boolean;
    onlyCompose: boolean;
    webhookUrl: string;
    webhookSecret: string; // masked except last 4
    appConfigured: boolean; // GitHub App env present
    oauthConfigured: boolean; // OAuth client id present
    appInstallUrl: string;
  };
  mcp: {
    enabled: boolean;
    transport: "http" | "sse";
    port: number; // 0 = serve /mcp on Dockhand's own port only
    tools: Record<string, { enabled: boolean; confirm: boolean }>;
  };
  updates: {
    auto: boolean;
    channel: "stable" | "beta" | "nightly";
    window: string; // "Sun 03:00–05:00"
    backup: boolean;
    build: "pull" | "build";
    redeployOnPush: boolean;
    repo: string; // "dockhand-app/dockhand"
    composeFile: string;
    timezone: string; // IANA zone the window is read in; "" = the server's zone
  };
  notifications: {
    hostDown: boolean;
    containerCrash: boolean;
    unhealthy: boolean;
    updates: boolean;
    diskSpace: boolean;
    deploys: boolean;
    digest: boolean;
  };
}

export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

// ─── System / self-update ──────────────────────────────────────────────────

/** GET /api/system/history?page=&limit= */
export interface UpdateHistoryPage {
  items: SystemInfo["history"];
  total: number;
  page: number;
  pages: number;
  limit: number;
}

/** GET /api/system/updater — the newest self-update helper container. */
export interface UpdaterStatus {
  state: "none" | "running" | "succeeded" | "failed";
  id?: string;
  exitCode?: number;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  log: string[];
}

export interface SystemInfo {
  version: string;
  latest: string; // "" if unknown
  updateAvailable: boolean;
  releasedAt: ISODate | null;
  notes: string[]; // changelog bullet points
  changelogUrl: string;
  checkedAt: ISODate | null;
  canSelfUpdate: boolean; // docker socket available
  source: { repo: string; branch: string; sha: string; path: string };
  history: { id: ID; version: string; fromVersion: string; status: string; note: string; at: ISODate }[];
  /** "git": updates are new commits on the checkout's branch; "release": GitHub releases. */
  mode?: "git" | "release";
  currentCommit?: string; // short sha the running stack was built from (git mode)
  checkError?: string; // why the last update check failed
  auto?: {
    enabled: boolean;
    timezone: string; // zone the window is evaluated in
    inWindow: boolean;
    nextWindow: ISODate | null; // when the window next opens (now, if inside it)
    lastCheck: ISODate | null;
    lastResult: string; // "Up to date", "Started update to abc1234", "Failed: …"
    error?: string; // the window can't be read
  };
}

// ─── Overview (fleet page + palette) ───────────────────────────────────────

export interface Overview {
  hosts: number;
  online: number;
  running: number;
  total: number;
  updates: number;
  unreadAlerts: number;
  attention: {
    severity: Severity;
    hostId: ID | null;
    host: string;
    text: string;
    action: string;
    href: string;
  }[];
}

export interface ApiError {
  error: string;
}

// ─── v2 design additions ───────────────────────────────────────────────────

/** GET /api/hosts/:id/disk — Docker disk usage breakdown (storage treemap). */
export interface DiskUsage {
  root: string; // docker root dir, e.g. "/var/lib/docker"
  used: number; // bytes used by Docker objects (sum of categories)
  capacity: number; // filesystem size holding the docker root
  categories: {
    key: "images" | "containers" | "volumes" | "buildCache";
    label: string; // "Images", "Containers", "Volumes", "Build cache"
    size: number;
    reclaimable: number; // bytes a prune would free
    count: number; // objects in the category
    active: number; // objects in use
  }[];
  reclaimable: number; // total reclaimable
}

/** A pre-flight problem shown in the deploy "issues" panel. */
export interface DeployIssue {
  field: string; // "Port 8080", "DB_PASSWORD", "Name", "Host", "Path", "Disk"
  text: string; // human explanation
  severity: "crit" | "warn";
  fix?: {
    label: string; // "Use 8081", "Generate", "Rename to web-2"
    // Values the UI merges into its form when the fix is applied.
    patch: {
      name?: string;
      path?: string;
      ports?: { from: string; to: string }[]; // replace host port `from` with `to`
      env?: KV[]; // set these env values
    };
  };
}

/** POST /api/deploy/check body. */
export interface DeployCheckInput {
  kind: "git" | "image" | "compose";
  hostId: ID;
  name: string; // container or stack name
  path?: string; // clone / stack path (git, compose)
  image?: string;
  ports?: { host: string; container: string }[];
  env?: KV[];
  requiredEnv?: string[]; // keys the repo marks as required
  composeFile?: string; // compose content (compose kind) — ports are read from it
}

export interface DeployCheckResult {
  ok: boolean; // no crit issues
  issues: DeployIssue[];
}

/** POST /api/deploy/git/dry-run and /api/containers/run/dry-run. */
export interface DryRunResult {
  ok: boolean;
  command: string; // what would run, e.g. "docker compose -p x config" or "docker run …"
  output: string; // rendered compose config / container create JSON, or the error
}

// ─── Fleet-wide lists (/api/fleet/*) ───────────────────────────────────────

export interface FleetList<T> {
  items: { hostId: ID; hostName: string; item: T }[];
  errors: { hostId: ID; hostName: string; error: string }[]; // hosts that failed to answer
  skipped: { hostId: ID; hostName: string; error: string }[]; // offline / pending hosts
}
