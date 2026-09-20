package machines

import (
	"context"
	"strconv"
	"strings"
	"time"

	"dockhand/internal/model"
)

// Facts are collected with one shell script per machine. It prints sections
// marked "@@<name>" and never fails: every command is best effort, so a host
// without apt, systemd or ss still returns what it has.
const collectScript = `
export LC_ALL=C PATH="$PATH:/usr/sbin:/sbin"
echo @@os; cat /etc/os-release 2>/dev/null
echo @@kernel; uname -r 2>/dev/null; uname -m 2>/dev/null
echo @@uptime; cat /proc/uptime 2>/dev/null; cat /proc/loadavg 2>/dev/null
echo @@temp; for f in /sys/class/thermal/thermal_zone*/temp; do [ -r "$f" ] && cat "$f" && break; done 2>/dev/null
echo @@root; id -u
echo @@sudo; if [ "$(id -u)" = 0 ]; then echo yes; elif sudo -n true 2>/dev/null; then echo yes; else echo no; fi
echo @@reboot; [ -f /var/run/reboot-required ] && echo yes || echo no; cat /var/run/reboot-required.pkgs 2>/dev/null
echo @@pkgmgr; command -v apt-get >/dev/null 2>&1 && echo apt || echo none
echo @@upgradable; apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null | grep '^Inst '
echo @@aptstamp; stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || stat -c %Y /var/cache/apt/pkgcache.bin 2>/dev/null
echo @@lastpatch; grep -h '^Start-Date' /var/log/apt/history.log 2>/dev/null | tail -1
echo @@services; systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | head -300
echo @@enabled; systemctl list-unit-files --type=service --state=enabled --no-pager --plain --no-legend 2>/dev/null | head -300
echo @@ports; ss -Hltnp 2>/dev/null || netstat -ltnp 2>/dev/null | tail -n +3
echo @@sshd; sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication|permitemptypasswords)' || grep -REhi '^[[:space:]]*(PasswordAuthentication|PermitRootLogin|PermitEmptyPasswords)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
echo @@firewall; ufw status 2>/dev/null | head -1; firewall-cmd --state 2>/dev/null; nft list ruleset 2>/dev/null | grep -E 'hook input .*policy drop' | head -2; iptables -S INPUT 2>/dev/null | head -40
echo @@unattended; systemctl is-enabled unattended-upgrades 2>/dev/null; cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
echo @@fail2ban; systemctl is-active fail2ban 2>/dev/null
echo @@needrestart; needrestart -b 2>/dev/null | sed -n 's/^NEEDRESTART-SVC: //p' | head -20
echo @@end
`

// sections splits the script's output on its "@@name" markers.
func sections(out string) map[string][]string {
	res := map[string][]string{}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		l := strings.TrimRight(line, "\r")
		if strings.HasPrefix(l, "@@") {
			cur = strings.TrimSpace(l[2:])
			continue
		}
		if cur != "" && strings.TrimSpace(l) != "" {
			res[cur] = append(res[cur], l)
		}
	}
	return res
}

func first(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}

// parse turns the script's output into facts.
func parse(out string) model.Machine {
	s := sections(out)
	m := model.Machine{PkgManager: first(s["pkgmgr"]), RebootPkgs: []string{}, Packages: []model.MachinePackage{},
		Services: []model.MachineService{}, Ports: []model.MachinePort{}, Checks: []model.MachineCheck{}, Baselines: []string{}, Pending: []string{}}

	osrel := map[string]string{}
	for _, l := range s["os"] {
		k, v, ok := strings.Cut(l, "=")
		if ok {
			osrel[k] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	m.OS = osrel["NAME"]
	m.Release = osrel["VERSION_ID"]
	if m.Release == "" {
		m.Release = osrel["VERSION"]
	}
	if m.OS == "" {
		m.OS = osrel["PRETTY_NAME"]
	}
	if m.OS == "" {
		m.OS = "Linux"
	}
	if k := s["kernel"]; len(k) > 0 {
		m.Kernel = strings.TrimSpace(k[0])
		if len(k) > 1 {
			m.Arch = strings.TrimSpace(k[1])
		}
	}
	if u := s["uptime"]; len(u) > 0 {
		if f := strings.Fields(u[0]); len(f) > 0 {
			sec, _ := strconv.ParseFloat(f[0], 64)
			m.UptimeSec = int(sec)
		}
		if len(u) > 1 {
			if f := strings.Fields(u[1]); len(f) >= 3 {
				m.Load = strings.Join(f[:3], " ")
			}
		}
	}
	if t := first(s["temp"]); t != "" {
		if milli, err := strconv.ParseFloat(t, 64); err == nil && milli > 1000 {
			c := milli / 1000
			m.TempC = &c
		}
	}
	for _, l := range s["needrestart"] {
		if u := strings.TrimSuffix(strings.TrimSpace(l), ".service"); u != "" {
			m.Pending = append(m.Pending, u)
		}
	}
	m.Sudo = first(s["sudo"]) == "yes"
	m.Reboot = first(s["reboot"]) == "yes"
	if len(s["reboot"]) > 1 {
		for _, p := range s["reboot"][1:] {
			if p = strings.TrimSpace(p); p != "" {
				m.RebootPkgs = append(m.RebootPkgs, p)
			}
		}
	}

	// "Inst libc6 [2.35-0ubuntu3.6] (2.35-0ubuntu3.8 Ubuntu:22.04/jammy-security [amd64])"
	for _, l := range s["upgradable"] {
		f := strings.Fields(l)
		if len(f) < 3 {
			continue
		}
		p := model.MachinePackage{Name: f[1]}
		rest := strings.Join(f[2:], " ")
		if cur, after, ok := strings.Cut(rest, "]"); ok && strings.HasPrefix(cur, "[") {
			p.Current = strings.TrimPrefix(cur, "[")
			rest = strings.TrimSpace(after)
		}
		rest = strings.TrimPrefix(rest, "(")
		rest = strings.TrimSuffix(strings.TrimSpace(rest), ")")
		if fs := strings.Fields(rest); len(fs) > 0 {
			p.Candidate = fs[0]
			if len(fs) > 1 {
				p.Origin = fs[1]
			}
		}
		low := strings.ToLower(rest)
		p.Security = strings.Contains(low, "-security") || strings.Contains(low, "security]") || strings.Contains(low, "esm-apps") || strings.Contains(low, "esm-infra")
		if p.Security {
			m.Security++
		}
		m.Packages = append(m.Packages, p)
	}
	if ts := first(s["aptstamp"]); ts != "" {
		if sec, err := strconv.ParseInt(ts, 10, 64); err == nil {
			t := time.Unix(sec, 0)
			m.AptUpdateAt = &t
		}
	}
	// "Start-Date: 2026-09-14  06:12:31"
	if lp := first(s["lastpatch"]); lp != "" {
		v := strings.TrimSpace(strings.TrimPrefix(lp, "Start-Date:"))
		v = strings.Join(strings.Fields(v), " ")
		if t, err := time.Parse("2006-01-02 15:04:05", v); err == nil {
			m.LastPatchAt = &t
		}
	}

	enabled := map[string]bool{}
	for _, l := range s["enabled"] {
		if f := strings.Fields(l); len(f) > 0 {
			enabled[strings.TrimSuffix(f[0], ".service")] = true
		}
	}
	// "ssh.service loaded active running OpenBSD Secure Shell server"
	for _, l := range s["services"] {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		if f[0] == "●" || f[0] == "*" { // failed units are marked
			f = f[1:]
		}
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") {
			continue
		}
		name := strings.TrimSuffix(f[0], ".service")
		sv := model.MachineService{Name: name, Active: f[3], Description: strings.Join(f[4:], " "), Enabled: enabled[name]}
		if f[2] == "failed" || f[3] == "failed" {
			sv.Active = "failed"
		}
		if sv.Active == "dead" {
			sv.Active = "inactive"
		}
		m.Services = append(m.Services, sv)
	}

	// "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))"
	seen := map[string]bool{}
	for _, l := range s["ports"] {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		addr := f[3]
		if strings.HasPrefix(l, "tcp") && len(f) >= 4 { // netstat layout
			addr = f[3]
		}
		i := strings.LastIndex(addr, ":")
		if i < 0 {
			continue
		}
		port, err := strconv.Atoi(addr[i+1:])
		if err != nil {
			continue
		}
		host := strings.Trim(addr[:i], "[]")
		p := model.MachinePort{Port: port, Address: host}
		p.Public = !(host == "127.0.0.1" || host == "::1" || strings.HasPrefix(host, "127."))
		if j := strings.Index(l, `users:(("`); j >= 0 {
			rest := l[j+len(`users:(("`):]
			if k := strings.Index(rest, `"`); k > 0 {
				p.Process = rest[:k]
			}
		} else if len(f) >= 7 && strings.Contains(f[len(f)-1], "/") { // netstat "812/sshd"
			_, name, _ := strings.Cut(f[len(f)-1], "/")
			p.Process = name
		}
		p.Process = strings.TrimSuffix(strings.TrimSpace(p.Process), ":")
		key := strconv.Itoa(port) + "/" + p.Process
		if seen[key] {
			continue
		}
		seen[key] = true
		m.Ports = append(m.Ports, p)
	}
	return m
}

// sshdValues reads the sshd settings out of the collected sections.
func sshdValues(out string) map[string]string {
	vals := map[string]string{}
	for _, l := range sections(out)["sshd"] {
		l = strings.TrimSpace(strings.TrimSuffix(l, ";"))
		l = strings.TrimPrefix(l, "#")
		f := strings.Fields(strings.ReplaceAll(l, "=", " "))
		if len(f) >= 2 {
			k := strings.ToLower(f[0])
			if _, ok := vals[k]; !ok { // first match wins, like sshd itself
				vals[k] = strings.ToLower(f[1])
			}
		}
	}
	return vals
}

// firewallActive reports whether inbound traffic is filtered, and whether ufw
// is installed. Docker's own iptables rules don't count: every Docker host has
// them and they don't protect the host's own ports.
func firewallActive(out string) (bool, bool) {
	ufw, active := false, false
	for _, l := range sections(out)["firewall"] {
		t := strings.TrimSpace(l)
		low := strings.ToLower(t)
		switch {
		case strings.HasPrefix(low, "status:"): // ufw
			ufw = true
			active = active || strings.Contains(low, "active")
		case low == "running": // firewalld
			active = true
		case strings.Contains(low, "hook input") && strings.Contains(low, "policy drop"): // nftables
			active = true
		case strings.HasPrefix(t, "-P INPUT"):
			active = active || strings.Contains(t, "DROP") || strings.Contains(t, "REJECT")
		case strings.HasPrefix(t, "-A INPUT"):
			if !strings.Contains(t, "DOCKER") && !strings.Contains(t, "docker0") && !strings.Contains(t, "br-") {
				active = true
			}
		}
	}
	return active, ufw
}

func unattendedOn(out string) bool {
	s := sections(out)
	enabled := false
	periodic := false
	for _, l := range s["unattended"] {
		t := strings.TrimSpace(l)
		if t == "enabled" || t == "static" {
			enabled = true
		}
		if strings.Contains(t, "Unattended-Upgrade") && strings.Contains(t, `"1"`) {
			periodic = true
		}
	}
	return enabled && periodic
}

func fail2banOn(out string) bool { return first(sections(out)["fail2ban"]) == "active" }

func isRoot(out string) bool { return first(sections(out)["root"]) == "0" }

// checks builds the hardening checks from the collected output.
func checks(out string, m *model.Machine, hostMethod string) []model.MachineCheck {
	ssh := sshdValues(out)
	fwActive, ufw := firewallActive(out)
	list := []model.MachineCheck{}
	add := func(c model.MachineCheck) { list = append(list, c) }

	sub := func(unknown bool, unknownText, text string) string {
		if unknown {
			return unknownText
		}
		return text
	}
	status := func(ok bool, unknown bool, warn bool) string {
		switch {
		case unknown:
			return "unknown"
		case ok:
			return "ok"
		case warn:
			return "warn"
		}
		return "bad"
	}

	pw, hasPw := ssh["passwordauthentication"]
	pwOff := pw == "no"
	add(model.MachineCheck{
		ID: "ssh-password", Group: "ssh", Title: "SSH password login disabled",
		Sub:    sub(!hasPw, "Couldn't read the SSH server's config", map[bool]string{true: "Keys only", false: "Passwords are accepted — keys only is safer"}[pwOff]),
		Status: status(pwOff, !hasPw, false),
		Fix:    map[bool]string{true: "", false: "ssh-password"}[pwOff || hostMethod == "password"],
		FixNote: "Writes PasswordAuthentication no to /etc/ssh/sshd_config.d/99-dockhand.conf and reloads sshd. " +
			"Make sure your key works first — you could lock yourself out.",
		FixRisky: true,
	})
	if hostMethod == "password" && !pwOff {
		list[len(list)-1].Sub = "Passwords are accepted — Dockhand connects to this host with a password, so turning it off would lock Dockhand out"
	}

	root, hasRoot := ssh["permitrootlogin"]
	rootOK := root == "no" || root == "prohibit-password" || root == "without-password" || root == "forced-commands-only"
	add(model.MachineCheck{
		ID: "ssh-root", Group: "ssh", Title: "Root SSH login restricted",
		Sub:      sub(!hasRoot, "Couldn't read the SSH server's config", map[bool]string{true: "PermitRootLogin " + root, false: "Root can log in with a password"}[rootOK]),
		Status:   status(rootOK, !hasRoot, false),
		Fix:      map[bool]string{true: "", false: "ssh-root"}[rootOK],
		FixNote:  "Sets PermitRootLogin prohibit-password (keys still work) and reloads sshd.",
		FixRisky: true,
	})

	add(model.MachineCheck{
		ID: "firewall", Group: "network", Title: "Firewall active",
		Sub:      sub(false, "", map[bool]string{true: "Filtering inbound traffic", false: "No firewall rules found (Docker's own rules don't count)"}[fwActive]),
		Status:   status(fwActive, false, !fwActive && !ufw),
		Fix:      map[bool]string{true: "", false: "firewall"}[fwActive || !ufw],
		FixNote:  "Runs ufw allow OpenSSH, then ufw --force enable. Anything else you expose must be allowed separately.",
		FixRisky: true,
	})

	auto := unattendedOn(out)
	add(model.MachineCheck{
		ID: "auto-updates", Group: "updates", Title: "Automatic security updates",
		Sub:     sub(m.PkgManager != "apt", "Only available on apt machines", map[bool]string{true: "unattended-upgrades is on", false: "Security patches are not installed automatically"}[auto]),
		Status:  status(auto, m.PkgManager != "apt", false),
		Fix:     map[bool]string{true: "", false: "auto-updates"}[auto || m.PkgManager != "apt"],
		FixNote: "Installs unattended-upgrades and enables daily security updates.",
	})

	add(model.MachineCheck{
		ID: "security-updates", Group: "updates", Title: "No pending security updates",
		Sub:     sub(m.PkgManager != "apt", "Only available on apt machines", map[bool]string{true: "Up to date", false: strconv.Itoa(m.Security) + " security update(s) waiting"}[m.Security == 0]),
		Status:  status(m.Security == 0, m.PkgManager != "apt", false),
		Fix:     map[bool]string{true: "", false: "security-updates"}[m.Security == 0 || m.PkgManager != "apt"],
		FixNote: "Installs the pending security updates now.",
	})

	add(model.MachineCheck{
		ID: "reboot", Group: "updates", Title: "No reboot pending",
		Sub:      map[bool]string{true: "Running the latest kernel and libraries", false: "A reboot is needed to finish an update"}[!m.Reboot],
		Status:   status(!m.Reboot, false, m.Reboot),
		Fix:      map[bool]string{true: "", false: "reboot"}[!m.Reboot],
		FixNote:  "Reboots the machine. Its containers restart with it.",
		FixRisky: true,
	})

	f2b := fail2banOn(out)
	add(model.MachineCheck{
		ID: "fail2ban", Group: "ssh", Title: "Brute-force protection",
		Sub:     map[bool]string{true: "fail2ban is running", false: "fail2ban isn't running"}[f2b],
		Status:  status(f2b, false, !f2b),
		Fix:     map[bool]string{true: "", false: "fail2ban"}[f2b || m.PkgManager != "apt"],
		FixNote: "Installs and starts fail2ban with its default SSH jail.",
	})

	pubKeys := 0
	for _, p := range m.Ports {
		if p.Public {
			pubKeys++
		}
	}
	add(model.MachineCheck{
		ID: "exposed-ports", Group: "network", Title: "Exposed services reviewed",
		Sub:    sub(len(m.Ports) == 0, "Couldn't read the listening ports", strconv.Itoa(pubKeys)+" port(s) listening on all interfaces"),
		Status: status(pubKeys <= 3, len(m.Ports) == 0, pubKeys > 3),
	})
	return list
}

// Rule is a baseline rule: one hardening check a baseline can require.
type Rule struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Group string `json:"group"`
}

// RuleTitles are the rule ids a baseline can contain, in display order.
var RuleTitles = []Rule{
	{"ssh-password", "Password login off", "ssh"},
	{"ssh-root", "Root login restricted", "ssh"},
	{"fail2ban", "Brute-force protection", "ssh"},
	{"firewall", "Firewall active", "network"},
	{"exposed-ports", "Exposed ports reviewed", "network"},
	{"auto-updates", "Automatic security updates", "updates"},
	{"security-updates", "No pending security updates", "updates"},
	{"reboot", "No reboot pending", "updates"},
}

// fixCommand returns the shell command for a check's fix, and whether it needs sudo.
func fixCommand(id string, m model.Machine) (string, bool) {
	switch id {
	case "ssh-password":
		return `mkdir -p /etc/ssh/sshd_config.d && printf '# written by Dockhand\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/99-dockhand.conf && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload)`, true
	case "ssh-root":
		return `mkdir -p /etc/ssh/sshd_config.d && printf '# written by Dockhand\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/98-dockhand-root.conf && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload)`, true
	case "firewall":
		return `ufw allow OpenSSH && ufw --force enable && ufw status`, true
	case "auto-updates":
		return `DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades && printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades && systemctl enable --now unattended-upgrades`, true
	case "security-updates":
		return `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade $(apt-get -s -o Debug::NoLocking=true dist-upgrade | awk '/^Inst/ && (/-security/ || /esm-(apps|infra)/) {print $2}' | tr '\n' ' ')`, true
	case "fail2ban":
		return `DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban && systemctl enable --now fail2ban`, true
	case "reboot":
		return `(sleep 1; systemctl reboot || reboot) >/dev/null 2>&1 &`, true
	}
	return "", false
}

// withSudo prefixes a command with sudo -n when the SSH user isn't root.
func withSudo(cmd string, root bool) string {
	if root {
		return cmd
	}
	return "sudo -n sh -c " + shQuote(cmd)
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'" }

// ctxTimeout is the per-machine collection budget.
func ctxTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}
