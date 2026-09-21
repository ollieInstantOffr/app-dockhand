# Dockhand

Manage, monitor and SSH into your Docker hosts — containers, compose stacks, images, volumes, networks,
live logs and terminals, GitHub deploys, uptime monitoring, alerts, and an MCP server so AI assistants can
operate your fleet. Dockhand talks to every host over SSH; there is nothing to install on the hosts.

## Run it

```bash
cp .env.example .env        # set DOCKHAND_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d --build
```

Open <http://localhost:5773> and create the admin account. With `DOCKHAND_AUTO_LOCAL=true` the machine Dockhand
runs on is added as a host automatically (through the mounted Docker socket).

Stacks and backups for the local host live in `/opt/dockhand` (mounted at the same path in the API
container). On macOS, where `/opt` isn't writable, set `DOCKHAND_HOME=$HOME/.dockhand` in `.env`.

Forgot the password?

```bash
docker compose exec api dockhand reset-password <username>
```

## Updating

Deploy Dockhand from a git checkout of this repository (`git clone … && docker compose up -d --build`).
Settings → Updates compares the commit the running stack was built from with the newest commit on the same
branch on GitHub; **Update** runs `git pull --ff-only` and `docker compose up -d --build` in a helper container,
so pushing to `main` is all it takes to ship a new version. Follow a running update with
`docker logs -f $(docker ps -lq --filter label=dockhand.helper=self-update)`.

With **Update automatically** on, Dockhand checks every five minutes while inside the update window (in the
chosen time zone) and installs a new version the same way. A version that fails to install isn't retried
automatically; the next newer one is.

## Architecture

```
browser ──► api (Go, :8080 → host :5773)
              ├─ /api/*, WebSockets, /mcp, /api/webhooks/github
              ├─ everything else ──► web (Next.js 16, standalone)
              ├─ Postgres 17 (schema + migrations owned by Prisma, applied by the `migrate` job)
              └─ Docker hosts over SSH (Docker API tunnelled through the SSH connection)
```

| Directory | What |
|---|---|
| `server/` | Go API: auth, SSH connection manager, pollers, Docker operations, jobs, GitHub deploys, uptime, alerts, MCP |
| `web/` | Next.js 16 App Router UI (React 19) |
| `db/` | Prisma schema and migrations; its Docker image runs `prisma migrate deploy` |
| `docs/API.md` | HTTP/WebSocket/MCP API reference (types in `web/lib/types.ts`) |
| `design/` | The source design (`Dockhand.dc.html`) |

### Fleet

The home page opens with an alert ticker, then **Fleet pulse**: average CPU, memory or disk across the
reachable hosts, the last 24 hours as a sparkline with a dashed line at 85%, a bar per host, and **Next best
actions** — crashed or unhealthy containers, hosts that are full, image and OS updates, pending reboots and
failing hardening checks, worst first. Each action opens the page that fixes it, or can be snoozed for a day.
Below that are the fleet donut and one card per host.

### All resources

**All resources** (spine, `G R`) lists every container, stack, image, volume and network across all hosts,
with a host filter, the same container filters and bulk actions as a host page, unused-image/volume filters and
a fleet-wide clean-up.

### Hosts

Add a host with its address and SSH user, then append Dockhand's public key (Settings → Hosts) to
`~/.ssh/authorized_keys` on it. The SSH user must be able to run `docker` without sudo. Host keys are pinned
on first connect. Password auth and the local Docker socket are also supported.

**Open SSH** on a host page opens a login shell on the host; its menu also lists a shell into every running
container. For the local host (Docker socket, no SSH) the host shell runs as root through a short-lived
privileged `alpine` helper that `nsenter`s the host's namespaces.

**Custom SSH** (the + menu, ⌘K or the terminal's + menu) opens a terminal to any address — a machine that isn't
a Dockhand host — with Dockhand's key, a password or a pasted private key. Credentials are used for that session
only and never stored; recent destinations and host key fingerprints are remembered in the browser, and a
changed host key is refused before anything is sent.

Compose stacks created through Dockhand live in `/opt/dockhand/stacks/<name>` on each host; `docker compose`
must be installed there. Deploys from GitHub stream the repository tarball through Dockhand, so hosts need
neither git nor your token.

**Alerts → Activity** lists every job Dockhand has run — deploys, updates, patches, backups, clean-ups — with who
started it, how long it took, and its steps and output.

### Blast radius

Before anything disruptive, Dockhand says what it takes down. **Blast radius** on a host page lists the
containers that stop, the stacks and published ports affected and the uptime checks that will fail; the same
report is folded into the reboot and stack-stop confirmations. On the Updates tab, selecting packages predicts
what installing them restarts — a docker package restarts the daemon and every container with it, a kernel
needs a reboot, libc restarts most services — alongside anything `needrestart` says is already waiting.

### Machines

A host's own page has the same thing under **OS & security**; the Machines page is the fleet-wide view of it.

**Machines** (spine, `G M`, or "OS & security" on a host page) manages the hosts themselves, over the same SSH
connection: pending apt updates (install everything, only security, or a selection), systemd services,
listening ports, and hardening checks — SSH password/root login, firewall, unattended-upgrades, pending
security updates, reboot required, fail2ban — most with a one-click fix. Facts are collected on demand and
every 30 minutes. Fixes and installs need the SSH user to be root or have passwordless sudo.

**Baselines** group machines under a set of those rules and show a machine × rule compliance grid; **Fix**
applies every failing rule across the group. Package management is apt-only (Debian, Ubuntu, Raspberry Pi OS);
services, ports and most checks work on any systemd machine.

### Registries

**Private registries** (Settings → Registries): save a login for Docker Hub, GHCR, GitLab, Quay or any other
registry and Dockhand uses it for pulls, compose deploys (including builds) and update checks on every host.
Hosts are never logged in — each docker command gets a temporary `DOCKER_CONFIG` (the host's own config plus the
saved logins) that is deleted when it finishes.

**Built-in registry**: Dockhand can host images itself. The `registry` service in `docker-compose.yml` (CNCF
distribution, not published) is served at `/v2/` on Dockhand's own port once turned on in Settings → Registries:

```bash
docker login dockhand.lan:5773            # Dockhand username + password, or any username + an access token
docker tag myapp:latest dockhand.lan:5773/myapp:1.0
docker push dockhand.lan:5773/myapp:1.0
```

Hosts pull with a read-only token Dockhand manages. Access tokens (push or pull-only) are for CI. Browse, deploy
and delete images in Settings → Registries; **Reclaim space** garbage-collects layers no tag uses. Docker only
talks to HTTP registries listed in `insecure-registries` (`/etc/docker/daemon.json`), except on localhost — serve
Dockhand over HTTPS to avoid configuring hosts.

### Pull & rebuild

Any stack that came from git has **Pull & rebuild** — `git pull` then `docker compose up -d --build`:

- **Deployed from GitHub by Dockhand**: the branch head is fetched through the GitHub API (no git or token on
  the host). Files deleted from the repo are removed from the stack folder too, like a real pull; files the app
  created there, and `.env`, are left alone.
- **A git clone on the host** (you cloned it and ran compose yourself): Dockhand runs git in that folder with the
  host's own credentials. It fast-forwards; if files were edited on the host or it has local commits, it asks
  before resetting to the remote (**Discard local changes** = `git reset --hard`). Untracked files are kept.

The dialog lists the commits you're about to get first, and can also pull newer base images or rebuild without
cache. MCP clients get the same as the `pull_and_rebuild` tool.

### GitHub

Personal access tokens work out of the box. For the OAuth device flow set `GITHUB_OAUTH_CLIENT_ID`; for a
GitHub App set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY` and set the app's setup URL to
`<public url>/api/github/app/callback`. Auto-deploy webhooks point at `<public url>/api/webhooks/github`, so
set `DOCKHAND_PUBLIC_URL` to an address GitHub can reach.

### MCP

Enable it in Settings → MCP, create an API key, and point your client at `<public url>/mcp` (Streamable HTTP)
with `Authorization: Bearer <key>`. Write tools can require an explicit `confirm: true` argument. MCP shares
Dockhand's port, so production needs only one opening; a dedicated MCP port is optional (Settings → MCP → Port).

## Development

```bash
docker compose up -d db migrate                     # Postgres + schema
cd server && DATABASE_URL=postgresql://dockhand:dockhand@localhost:5432/dockhand?sslmode=disable \
  DOCKHAND_SECRET=dev DOCKHAND_WEB_URL=http://localhost:3000 go run ./cmd/dockhand
cd web && npm install && npm run dev                # http://localhost:3000, /api proxied to :8080
```

For local development publish the database port (add `ports: ["5432:5432"]` to `db`). In `next dev`,
WebSockets go straight to the API: set `NEXT_PUBLIC_DOCKHAND_WS_ORIGIN=http://localhost:8080`, or browse
the API's port (`http://localhost:8080`), which proxies the dev server.

Schema changes: edit `db/prisma/schema.prisma`, then `cd db && npx prisma migrate dev --name <change>`.
