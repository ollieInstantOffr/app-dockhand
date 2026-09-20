// Command dockhand runs the Dockhand API server, or a maintenance subcommand:
//
//	dockhand                              run the server
//	dockhand reset-password <username>    set a new password (reads --password or stdin)
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"dockhand/internal/alerts"
	"dockhand/internal/api"
	"dockhand/internal/auth"
	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/deploycheck"
	"dockhand/internal/dockerops"
	"dockhand/internal/gitdeploy"
	"dockhand/internal/hosts"
	"dockhand/internal/impact"
	"dockhand/internal/jobs"
	"dockhand/internal/machines"
	"dockhand/internal/mcp"
	"dockhand/internal/mcptools"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/regauth"
	"dockhand/internal/registry"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
	"dockhand/internal/sshkeys"
	"dockhand/internal/stacks"
	"dockhand/internal/system"
	"dockhand/internal/uptime"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = ""

func main() {
	level := slog.LevelInfo
	if os.Getenv("DOCKHAND_DEBUG") == "true" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	if version != "" {
		config.Version = version
	}
	cfg := config.Load()
	if version != "" && os.Getenv("DOCKHAND_VERSION") == "" {
		cfg.Version = version
	}

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "reset-password":
			os.Exit(resetPassword(cfg, os.Args[2:]))
		case "version", "--version", "-v":
			fmt.Println(cfg.Version)
			return
		case "help", "--help", "-h":
			fmt.Println("usage: dockhand [reset-password <username> [--password <pw>] | version]")
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown command %q (try: dockhand reset-password <username>)\n", os.Args[1])
			os.Exit(2)
		}
	}
	if err := run(cfg); err != nil {
		slog.Error("dockhand stopped", "err", err)
		os.Exit(1)
	}
}

func resetPassword(cfg *config.Config, args []string) int {
	fs := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	pw := fs.String("password", "", "new password (min 12 characters); read from stdin when omitted")
	// Allow the username before or after flags.
	var username string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		username, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if username == "" && fs.NArg() > 0 {
		username = fs.Arg(0)
	}
	if username == "" {
		fmt.Fprintln(os.Stderr, "usage: dockhand reset-password <username> [--password <new password>]")
		return 2
	}
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is not set")
		return 1
	}
	password := *pw
	if password == "" {
		var err error
		password, err = readPassword()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	if err := auth.ValidatePassword(password); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot connect to the database:", err)
		return 1
	}
	defer pool.Close()
	if err := auth.New(pool).ResetPassword(ctx, username, password); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("Password for %q updated. All of their sessions were signed out.\n", strings.ToLower(username))
	return 0
}

func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "New password: ")
		a, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		fmt.Fprint(os.Stderr, "Repeat password: ")
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if string(a) != string(b) {
			return "", errors.New("passwords do not match")
		}
		return string(a), nil
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no password given (pass --password or pipe it on stdin)")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func run(cfg *config.Config) error {
	if cfg.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if !config.SecretSet() {
		slog.Warn("DOCKHAND_SECRET is not set — stored credentials are encrypted with an empty key; set it before adding hosts")
	}
	if config.SecretIsPlaceholder() {
		return errors.New("DOCKHAND_SECRET is still the .env.example placeholder; set it to a random value (openssl rand -hex 32) and keep it — changing it later makes stored keys unreadable")
	}
	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Background services run on their own context so shutdown can drain jobs first.
	svcCtx, cancelSvc := context.WithCancel(context.Background())
	defer cancelSvc()

	pool, err := db.Open(rootCtx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer pool.Close()

	box, err := secret.New(cfg.Secret)
	if err != nil {
		return err
	}
	defaults := settings.Defaults(cfg.PublicURL, mcptools.ToolInfos())
	defaults.MCP.Port = cfg.MCPPort // new installs serve MCP on the published port
	mcptools.PublishedPort = cfg.MCPPort
	st := settings.New(pool, defaults)
	if err := st.Load(rootCtx); err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	// Installs from when compose published a dedicated MCP port by default (8787) move back
	// to /mcp on Dockhand's own port unless that port is still published.
	if cfg.MCPPort == 0 && st.Get().MCP.Port == 8787 {
		if err := st.Update(rootCtx, "mcp", func(s *settings.Settings) { s.MCP.Port = 0 }); err != nil {
			slog.Warn("reset mcp port", "err", err)
		}
	}
	hostKey, err := sshkeys.LoadOrCreate(rootCtx, st, box, sshkeys.KeyHost, "dockhand")
	if err != nil {
		return fmt.Errorf("ssh key: %w", err)
	}
	deployKey, err := sshkeys.LoadOrCreate(rootCtx, st, box, sshkeys.KeyDeploy, "dockhand-deploy")
	if err != nil {
		return fmt.Errorf("deploy key: %w", err)
	}

	authSvc := auth.New(pool)
	hostStore := hosts.NewStore(pool, box)
	conns := hosts.NewManager(hostStore, box, hostKey.Signer)
	alertEngine := alerts.New(svcCtx, pool, st, box)
	mon := monitor.New(pool, hostStore, conns, st, alertEngine)
	jobRunner := jobs.NewRunner(svcCtx, pool)
	if err := jobRunner.FailStale(rootCtx); err != nil {
		slog.Warn("mark stale jobs", "err", err)
	}
	ops := dockerops.New(cfg, hostStore, conns, mon, jobRunner, st)
	stackSvc := stacks.New(cfg, pool, hostStore, conns, mon, jobRunner)
	gitSvc := gitdeploy.New(svcCtx, cfg, pool, box, st, hostStore, conns, mon, jobRunner, stackSvc)
	if err := gitSvc.EnsureWebhookSecret(rootCtx); err != nil {
		slog.Warn("webhook secret", "err", err)
	}
	upSvc := uptime.New(pool, st, mon, alertEngine)
	mon.OnContainerStarted = upSvc.AutoMonitor
	mcpProvider := mcptools.New(pool, st, hostStore, mon, ops, stackSvc, gitSvc, jobRunner)
	sysSvc := system.New(cfg, pool, st, jobRunner)
	sysSvc.RecordBoot(rootCtx)
	regSvc := registry.New(cfg, pool, box, st, authSvc, jobRunner)
	if err := regSvc.EnsureSystemToken(rootCtx); err != nil {
		slog.Warn("registry system token", "err", err)
	}
	regauth.Src = regSvc
	machineSvc := machines.New(pool, hostStore, conns, jobRunner)
	impactSvc := impact.New(hostStore, mon, upSvc)
	machineSvc.Impact = func(ctx context.Context, hostID string) (model.Impact, error) {
		return impactSvc.Host(ctx, hostID, "patch")
	}
	sysSvc.OnAutoUpdate = func(target, jobID string) {
		alertEngine.Event(context.Background(), alerts.Spec{Key: "auto_update:" + jobID, Severity: "info", Kind: "self_update",
			Title: "Dockhand is updating itself to " + target, Text: "Automatic update inside the update window. Dockhand restarts in a minute or two.",
			Action: "Open", Href: "/settings/updates", Pref: alerts.PrefUpdates})
	}

	// Alert on failed deploys / updates.
	jobRunner.OnFinish(func(j model.Job, actor string) {
		key := "deploy_failed:" + j.ID
		switch j.Kind {
		case "git", "compose", "stack", "image", "update", "self-update", "pull", "backup":
		default:
			return
		}
		hostID := ""
		if j.HostID != nil {
			hostID = *j.HostID
		}
		if j.Status == "failed" {
			text := ""
			for i := len(j.Log) - 1; i >= 0; i-- {
				if j.Log[i].Level == "error" {
					text = j.Log[i].Text
					break
				}
			}
			alertEngine.Raise(context.Background(), alerts.Spec{Key: key, Severity: "warn", Kind: "deploy_failed", Title: j.Title + " failed",
				Text: text, HostID: hostID, Action: "Retry", Href: "/deploy?job=" + j.ID, Pref: alerts.PrefDeploys})
		} else if actor == "auto-deploy" {
			alertEngine.Event(context.Background(), alerts.Spec{Key: "deploy_ok:" + j.ID, Severity: "ok", Kind: "deploy_ok", Title: j.Title + " succeeded",
				HostID: hostID, Action: "Open", Href: "/deploy?job=" + j.ID, Pref: alerts.PrefDeploys})
		}
	})

	if cfg.AutoLocal && config.HasLocalDocker() {
		if n, err := hostStore.Count(rootCtx); err == nil && n == 0 {
			if _, err := hostStore.Create(rootCtx, model.HostInput{Name: "local", Method: "local", Color: "#12a594"}); err != nil {
				slog.Warn("auto-create local host", "err", err)
			} else {
				slog.Info("created host \"local\" for the local Docker socket")
			}
		}
	}

	handler, err := api.New(api.Deps{Cfg: cfg, DB: pool, Auth: authSvc, Settings: st, Hosts: hostStore, Conns: conns, Monitor: mon,
		Ops: ops, Stacks: stackSvc, Jobs: jobRunner, Git: gitSvc, Uptime: upSvc, Alerts: alertEngine, MCP: mcpProvider,
		System: sysSvc, Registry: regSvc, Machines: machineSvc, Impact: impactSvc, HostKey: hostKey, DeployKey: deployKey, Preflight: deploycheck.New(hostStore, ops, stackSvc, mon)})
	if err != nil {
		return err
	}

	go mon.Run(svcCtx)
	go upSvc.Run(svcCtx)
	go gitSvc.SyncLoop(svcCtx)
	go sysSvc.RunAutoUpdates(svcCtx)
	go machineSvc.Run(svcCtx)
	go mcpProvider.RunDedicated(svcCtx, mcp.NewHandler(mcpProvider, "dockhand", cfg.Version))
	go housekeeping(svcCtx, authSvc, hostStore, conns, mon, upSvc, alertEngine, mcpProvider, jobRunner)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("dockhand listening", "addr", cfg.Listen, "version", cfg.Version, "ui", cfg.WebURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-rootCtx.Done():
	}
	slog.Info("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	// Give running jobs a chance to finish, then stop background services.
	jobRunner.Wait(shutCtx)
	cancelSvc()
	conns.CloseAll()
	return nil
}

// housekeeping runs retention and idle-connection cleanup.
func housekeeping(ctx context.Context, a *auth.Service, hs *hosts.Store, conns *hosts.Manager, mon *monitor.Monitor,
	up *uptime.Service, al *alerts.Engine, mp *mcptools.Provider, jr *jobs.Runner) {
	idle := time.NewTicker(time.Minute)
	hourly := time.NewTicker(time.Hour)
	defer idle.Stop()
	defer hourly.Stop()
	prune := func() {
		c, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		for name, fn := range map[string]func(context.Context) error{
			"sessions": a.PruneSessions, "metrics": hs.PruneMetrics, "events": mon.PruneEvents, "checks": up.Prune,
			"alerts": al.Prune, "mcp activity": mp.Prune,
			"jobs": func(c context.Context) error { return jr.Prune(c, 90*24*time.Hour) },
		} {
			if err := fn(c); err != nil {
				slog.Warn("retention", "what", name, "err", err)
			}
		}
	}
	prune()
	for {
		select {
		case <-ctx.Done():
			return
		case <-idle.C:
			conns.CloseIdle()
		case <-hourly.C:
			prune()
			conns.SweepHelpers(ctx)
		}
	}
}
