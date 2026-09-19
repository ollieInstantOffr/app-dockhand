# Dockhand HTTP API

The Go API (`server/`) is the single public entrypoint on port 8080. It serves:

- `/api/*` — the JSON API below (session cookie auth)
- `/api/*` WebSockets — logs, terminals (same cookie)
- `/mcp` — the MCP endpoint (Bearer API key)
- `/api/webhooks/github` — GitHub push webhook (HMAC-verified, no cookie)
- everything else — reverse-proxied to the Next.js UI (`DOCKHAND_WEB_URL`)

Response shapes are defined in [`web/lib/types.ts`](../web/lib/types.ts); names below refer to those types.

## Conventions

- JSON in and out, camelCase keys, RFC 3339 timestamps, sizes in bytes, percentages 0–100.
- Errors: non-2xx status with `{"error": "human readable message"}`.
  `401` means not signed in; the UI redirects to `/login` (or `/setup` if `setupRequired`).
- Auth: `dockhand_session` cookie (HttpOnly, SameSite=Lax, 30 days with "stay signed in", browser session otherwise).
  Mutating requests must send `X-Requested-With: dockhand` (CSRF guard).
- Long-running work returns `JobRef` (`{"jobId": "…"}`) immediately. Poll `GET /api/jobs/:id` (the UI polls every 700 ms) until `status != "running"`.
- Lists are returned as bare JSON arrays.

## Auth & account

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/auth/state` | – | `AuthState` (public) |
| POST | `/api/auth/setup` | `{name, username, password}` | `User` — only while no users exist; signs in |
| POST | `/api/auth/login` | `{username, password, remember}` | `User` |
| POST | `/api/auth/logout` | – | `{}` |
| GET | `/api/account` | – | `Account` |
| PATCH | `/api/account` | `{name?, username?, theme?, currentPassword?, newPassword?}` | `User` |
| DELETE | `/api/account/sessions/:id` | – | `{}` (revoke) |
| GET | `/api/ssh-key` | – | `SshKeyInfo` (Dockhand's host key, generated on first boot) |
| GET | `/api/deploy-key` | – | `SshKeyInfo` (read-only git deploy key) |

## Overview & search

| GET | `/api/overview` | – | `Overview` |
|---|---|---|---|
| GET | `/api/containers` | – | `Container[]` across all hosts (cached from the poller; for palette + pickers) |

## Hosts

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/hosts` | – | `Host[]` (sorted) |
| POST | `/api/hosts` | `HostInput` | `Host` (status `pending`) |
| POST | `/api/hosts/test` | `HostInput` | `HostTestResult` — dry-run, nothing saved |
| GET | `/api/hosts/:id` | – | `Host` |
| PATCH | `/api/hosts/:id` | `Partial<HostInput> & {monitored?, mcpExposed?}` | `Host` |
| DELETE | `/api/hosts/:id` | – | `{}` |
| POST | `/api/hosts/:id/test` | – | `HostTestResult` (updates status) |
| POST | `/api/hosts/:id/reboot` | – | `{}` (`sudo -n reboot` over SSH) |
| POST | `/api/hosts/:id/prune` | `{containers, images, networks, volumes, buildCache}` (bools) | `JobRef` |
| POST | `/api/hosts/:id/update-all` | – | `JobRef` (update every container with an image update) |
| GET | `/api/hosts/:id/metrics?range=1h` | – | `{at: ISODate, cpu, mem, disk}[]` |
| GET | `/api/hosts/:id/disk` | – | `DiskUsage` — Docker `system df` by category (images, containers, volumes, build cache) with reclaimable bytes; `capacity` = size of the filesystem holding `DockerRootDir` (`df` on the host, falls back to the host's disk total). Cached 30 s |

Test steps (in order): `Resolving address`, `Opening SSH connection`, `Authenticating`, `Checking Docker`, `Reading host info`.
For `method: "local"` the SSH steps are `skipped` and Docker is reached via `/var/run/docker.sock`.

## Containers

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/hosts/:id/containers` | – | `Container[]` |
| GET | `/api/hosts/:id/containers/:cid` | – | `ContainerDetail` |
| POST | `/api/hosts/:id/containers/:cid/:action` | – | `Container` (`start stop restart pause unpause kill`) or `JobRef` for `update` |
| POST | `/api/hosts/:id/containers/bulk` | `{ids: string[], action}` | `{ok: string[], failed: {id, error}[]}` |
| PATCH | `/api/hosts/:id/containers/:cid` | `{env?: KV[], restartPolicy?}` | `JobRef` (recreates the container with the new config) |
| DELETE | `/api/hosts/:id/containers/:cid?force=1&volumes=0` | – | `{}` |
| POST | `/api/containers/run` | `RunContainerInput` | `JobRef` (pull → create → start) |
| POST | `/api/containers/run/dry-run` | `RunContainerInput` | `DryRunResult` — `command` = equivalent `docker run …`, `output` = JSON `{config, hostConfig, networkingConfig}` exactly as the run would send them; nothing is created. Validation errors → `ok: false` |
| GET | `/api/hosts/:id/containers/:cid/logs?tail=500&since=1h&download=1` | – | `text/plain` log download |
| WS | `/api/hosts/:id/containers/:cid/logs/ws?tail=200&since=&follow=1` | – | server → client text frames, one JSON object per line: `{"t": ISODate, "stream": "stdout"|"stderr", "line": "…"}` |
| WS | `/api/hosts/:id/containers/:cid/exec?cmd=/bin/sh&cols=120&rows=32` | – | terminal (see below) |
| WS | `/api/hosts/:id/shell?cols=120&rows=32` | – | Login shell on the host: SSH, or an nsenter helper for the local host (terminal protocol) |
| WS | `/api/ssh?cols=120&rows=32` | – | Custom SSH to any address. First message: `{"type":"connect","address","port","user","auth":"key\|password\|privateKey","password"?,"privateKey"?,"passphrase"?,"hostKey"?}`; the server replies `{"type":"hostkey","fingerprint"}` and refuses before authenticating when `hostKey` (a SHA256 fingerprint) doesn't match. Then the terminal protocol |

Terminal protocol: server → client **binary** frames carry raw PTY output. Client → server **text** frames are JSON:
`{"type":"input","data":"ls\r"}` or `{"type":"resize","cols":120,"rows":32}`. The server closes the socket with a
text frame `{"type":"exit","code":0}` when the process ends. The UI renders it with xterm.js.

## Stacks (docker compose)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/hosts/:id/stacks` | – | `Stack[]` (managed + discovered from `com.docker.compose.project` labels) |
| POST | `/api/hosts/:id/stacks` | `{name, content}` | `JobRef` — writes `<stacksDir>/<name>/docker-compose.yml` and runs `up -d` |
| GET | `/api/hosts/:id/stacks/:name/compose` | – | `{path, content}` |
| PUT | `/api/hosts/:id/stacks/:name/compose` | `{content}` | `JobRef` (validate, write, `up -d --remove-orphans`) |
| POST | `/api/hosts/:id/stacks/:name/:action` | – | `JobRef` — `up down stop restart pull redeploy` (redeploy = `git pull` for git stacks, then `pull` + `up -d`) |
| PATCH | `/api/hosts/:id/stacks/:name` | `{autoDeploy}` | `Stack` |
| POST | `/api/compose/validate` | `{content}` | `ComposeValidation` (YAML parse + basic schema) |
| GET | `/api/compose/templates` | – | `{id, label, content}[]` (Blank, Web app + Postgres, Static site, …) |

Stacks live under `/opt/dockhand/stacks` on each host (`DOCKHAND_STACKS_DIR`).

## Images, volumes, networks

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/hosts/:id/images` | – | `Image[]` |
| DELETE | `/api/hosts/:id/images/:iid?force=1` | – | `{}` |
| POST | `/api/hosts/:id/images/prune` | – | `{count, reclaimed}` (unused, not just dangling) |
| POST | `/api/images/pull` | `{image, tag, hostIds}` | `JobRef` (log lines mirror docker pull progress) |
| GET | `/api/images/tags?image=nginx` | – | `{name, updatedAt, size}[]` (Docker Hub / GHCR tags, best effort) |
| GET | `/api/images/inspect?image=nginx:1.27` | – | `{size, exposedPorts: string[], volumes: string[], env: KV[]}` (registry manifest, best effort) |
| GET | `/api/images/search?q=postgres` | – | `{name, description, stars, pulls, official}[]` (Docker Hub repository search, up to 8, best effort) |
| GET | `/api/hosts/:id/volumes` | – | `Volume[]` |
| DELETE | `/api/hosts/:id/volumes/:name` | – | `{}` |
| POST | `/api/hosts/:id/volumes/backup` | `{names?: string[]}` | `JobRef` — tars each volume to `/opt/dockhand/backups/<vol>-<ts>.tar.gz` via a helper `alpine` container |
| GET | `/api/hosts/:id/networks` | – | `Network[]` |
| POST | `/api/hosts/:id/networks` | `NetworkInput` | `Network` |
| GET | `/api/hosts/:id/networks/:nid` | – | raw `docker network inspect` JSON |
| DELETE | `/api/hosts/:id/networks/:nid` | – | `{}` |
| POST | `/api/hosts/:id/networks/prune` | – | `{removed: string[]}` |
| POST | `/api/hosts/:id/networks/:nid/connect` | `{container}` | `{}` |
| POST | `/api/hosts/:id/networks/:nid/disconnect` | `{container}` | `{}` |

## Jobs

| GET | `/api/jobs/:id` | – | `Job` |
|---|---|---|---|
| GET | `/api/jobs?limit=20` | – | `Job[]` (recent, without log) |

## GitHub

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/github/accounts` | – | `GitAccount[]` |
| POST | `/api/github/accounts` | `GitAccountInput` | `GitAccount` (validates the token, then syncs repos in the background) |
| PATCH | `/api/github/accounts/:id` | `{enabled?, repoAccess?, selectedRepos?, webhook?}` | `GitAccount` |
| DELETE | `/api/github/accounts/:id` | – | `{}` |
| POST | `/api/github/accounts/:id/sync` | – | `GitAccount` |
| POST | `/api/github/oauth/device` | `{serverUrl?}` | `DeviceFlowStart` (needs `GITHUB_OAUTH_CLIENT_ID`) |
| POST | `/api/github/oauth/poll` | `{deviceCode}` | `{status: "pending"|"ok"|"expired"|"denied", account?: GitAccount}` |
| GET | `/api/github/app/callback?installation_id=…` | – | redirect to `/settings/github` after storing the installation (needs `GITHUB_APP_ID` + key) |
| GET | `/api/github/repos?q=&compose=1&accountId=` | – | `Repo[]` |
| GET | `/api/github/account-repos?accountId=` | – | `Repo[]` (all repos, for the selected-repos picker) |
| GET | `/api/github/repos/:owner/:name/branches` | – | `Branch[]` |
| GET | `/api/github/repos/:owner/:name/inspect?ref=&file=` | – | `RepoInspect` |
| POST | `/api/deploy/git` | `GitDeployInput` | `JobRef` |
| POST | `/api/deploy/git/dry-run` | `GitDeployInput` | `DryRunResult` — fetches the compose file (+ `.env.example`) at the branch, adds a `.env` from `env` and runs `docker compose -p <name> -f <file> config` inside the API container (20 s). Errors → `ok: false` with compose's message; on interpolation errors the un-interpolated file is appended |
| POST | `/api/deploy/check` | `DeployCheckInput` | `DeployCheckResult` — pre-flight checks (see below), answers within ~8 s |
| POST | `/api/webhooks/github` | GitHub push payload | `{}` — verifies `X-Hub-Signature-256`, redeploys matching stacks with `autoDeploy` |
| POST | `/api/settings/github/rotate-secret` | – | `{secret}` (full value, shown once) |

Deploy check issues (`DeployIssue`, `ok` = no `crit`): host missing/offline/unreachable (`Host`, crit); invalid name, or
lowercase compose rule for git/compose (`Name`, crit); name taken — container for `image` (crit), stack/compose project for
git/compose (warn, "updated in place"), fix "Rename to `<name>-N`"; host ports from `ports` and from `composeFile` content
(variables resolved from `env`) already published by another container or listening on the host (`ss -Hltn`/`netstat`,
SSH hosts only) → `Port <n>` crit with fix "Use `<next free>`"; empty `requiredEnv` keys (crit, secret-looking keys get a
"Generate" fix); `path` not absolute / contains `..` (crit), is a file (crit), or is a non-empty directory of another
stack (warn); host disk ≥ 90 % (warn) / ≥ 97 % (crit); invalid image reference (crit, nothing is pulled). Host checks that
don't finish in time are skipped rather than failing the request.

## Uptime

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/uptime?window=24h` | – | `UptimeOverview` |
| POST | `/api/monitors` | `MonitorInput` | `MonitorView` |
| PATCH | `/api/monitors/:id` | `{enabled?, name?, target?}` | `MonitorView` |
| DELETE | `/api/monitors/:id` | – | `{}` |
| POST | `/api/monitors/:id/check` | – | `MonitorView` (runs a check now) |
| GET | `/api/public/status` | – | `{title, overall, monitors: {name, status, pct, bars}[]}` — public, only when `uptime.publicStatus` |

## Alerts & notifications

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/alerts?filter=all|unread|critical` | – | `Alert[]` (newest first, snoozed hidden) |
| POST | `/api/alerts/read-all` | – | `{}` |
| POST | `/api/alerts/:id/read` | – | `{}` |
| POST | `/api/alerts/:id/snooze` | `{minutes}` | `{}` |
| GET | `/api/notifications/channels` | – | `NotificationChannel[]` |
| POST | `/api/notifications/channels` | `{type, name, config, enabled}` | `NotificationChannel` |
| PATCH | `/api/notifications/channels/:id` | partial | `NotificationChannel` |
| DELETE | `/api/notifications/channels/:id` | – | `{}` |
| POST | `/api/notifications/channels/:id/test` | – | `{ok, error}` |

Channel config keys — email: `host, port, username, password, from, to`; slack/webhook: `url`; ntfy: `url, topic, token`.

## Settings, MCP, system

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/settings` | – | `Settings` |
| PATCH | `/api/settings` | `SettingsPatch` (deep-merged per section) | `Settings` |
| GET | `/api/mcp` | – | `McpStatus` |
| GET | `/api/mcp/keys` | – | `ApiKey[]` |
| POST | `/api/mcp/keys` | `ApiKeyInput` | `ApiKey & {key: string}` (full key shown once) |
| DELETE | `/api/mcp/keys/:id` | – | `{}` (revoke) |
| GET | `/api/mcp/activity?limit=50` | – | `McpActivity[]` |
| GET | `/api/system` | – | `SystemInfo` |
| POST | `/api/system/check` | – | `SystemInfo` |
| POST | `/api/system/update` | – | `JobRef` |
| POST | `/api/system/rollback` | – | `JobRef` |

## MCP endpoint

`POST /mcp` — MCP Streamable HTTP transport (JSON-RPC 2.0, protocol `2025-06-18`), `Authorization: Bearer dh_…`.
Implements `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. `GET /mcp` returns 405 (no server-initiated stream).
Tools are filtered by the global enable switch, the per-tool toggles in settings, the key's scope/groups and host list.
Write tools with "confirm" enabled require the argument `"confirm": true`; without it the call returns a tool error
explaining what would happen. Every call is written to `mcp_activity`.

By default (`settings.mcp.port` = 0) MCP is only served here, on Dockhand's own port, so a deployment behind a
reverse proxy exposes it at `<public url>/mcp` with no extra port. When `settings.mcp.port` is non-zero (1024–65535) and MCP is enabled, the same endpoint is also served on a dedicated
listener at `:<port>/mcp` (publish that port from the container to reach it). `GET /api/mcp` then reports the URL with
that port, `port`, and `listenError` if the listener couldn't bind.

### MCP OAuth

Clients that can't send a static key (Claude chat, Cowork, Claude Code without `--header`) use OAuth 2.1:
a 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`.

| Method | Path | Notes |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| POST | `/oauth/register` | Dynamic client registration (RFC 7591); redirect URIs must be https or http loopback |
| GET | `/oauth/authorize` | Validates, then redirects to the `/connect` consent page (PKCE S256 required) |
| POST | `/oauth/token` | `authorization_code` grant; the access token is a new API key |
| GET | `/api/oauth/request?<authorize query>` | Consent page: client name, redirect host, whether MCP is on |
| POST | `/api/oauth/approve` | `{query, approve, scope: "read"|"full", hostIds}` → `{redirect}` |
