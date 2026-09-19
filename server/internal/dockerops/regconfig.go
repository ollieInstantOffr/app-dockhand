package dockerops

import (
	"context"
	"fmt"
	"strings"
	"time"

	"dockhand/internal/hosts"
	"dockhand/internal/regauth"
	"dockhand/internal/util"
)

// withRegistryConfig lets a docker CLI command on a host use Dockhand's saved
// registry credentials without logging the host in: it writes a temporary
// DOCKER_CONFIG (the host's own config.json plus the credentials, private to
// the SSH user) and removes it afterwards. The host's CLI plugins and contexts
// stay available through symlinks.
func withRegistryConfig(ctx context.Context, conn *hosts.Conn, cmd string) (string, func(), error) {
	if regauth.Src == nil {
		return cmd, func() {}, nil
	}
	creds := regauth.Src.All(ctx)
	if len(creds) == 0 {
		return cmd, func() {}, nil
	}
	prep := strings.Join([]string{
		"umask 077",
		// Leftovers from runs that were killed before cleaning up.
		"find /tmp -maxdepth 1 -name 'dockhand-cfg-*' -mmin +120 -exec rm -rf {} + 2>/dev/null",
		"d=$(mktemp -d /tmp/dockhand-cfg-XXXXXX) || exit 1",
		`o="${DOCKER_CONFIG:-$HOME/.docker}"`,
		`for x in cli-plugins contexts; do [ -e "$o/$x" ] && ln -s "$o/$x" "$d/$x"; done`,
		`echo "$d"`,
		`cat "$o/config.json" 2>/dev/null; true`,
	}, "; ")
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	res, err := conn.Exec(pctx, prep, nil)
	if err != nil {
		return "", nil, err
	}
	dir, existing, _ := strings.Cut(res.Stdout, "\n")
	dir = strings.TrimSpace(dir)
	if !strings.HasPrefix(dir, "/tmp/dockhand-cfg-") {
		return "", nil, fmt.Errorf("couldn't create a temporary docker config: %s", strings.TrimSpace(res.Stdout+res.Stderr))
	}
	cleanup := func() {
		c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, _ = conn.Exec(c, "rm -rf "+util.Shq(dir), nil)
	}
	cfg := regauth.MergeDockerConfig([]byte(existing), creds)
	wctx, wcancel := context.WithTimeout(ctx, 20*time.Second)
	defer wcancel()
	if res, err := conn.Exec(wctx, "umask 077; cat > "+util.Shq(dir+"/config.json"), strings.NewReader(string(cfg))); err != nil || res.Code != 0 {
		cleanup()
		if err == nil {
			err = fmt.Errorf("exit %d", res.Code)
		}
		return "", nil, err
	}
	return "export DOCKER_CONFIG=" + util.Shq(dir) + "; " + cmd, cleanup, nil
}
