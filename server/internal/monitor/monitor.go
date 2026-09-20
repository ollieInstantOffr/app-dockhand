// Package monitor polls hosts for facts, metrics, containers and stats,
// follows Docker events, checks for image updates and keeps an in-memory
// cache the API reads from.
package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"

	"dockhand/internal/alerts"
	"dockhand/internal/db"
	"dockhand/internal/hosts"
	"dockhand/internal/model"
	"dockhand/internal/settings"
)

const (
	pollInterval    = 10 * time.Second
	pollTimeout     = 20 * time.Second
	sparkLen        = 20
	historyLen      = 24
	statsWorkers    = 8
	updateInterval  = 6 * time.Hour
	thresholdPct    = 90
	expectedActionT = 30 * time.Second
)

type ctrStats struct {
	prevCPU, prevSys uint64
	prevRx, prevTx   uint64
	prevAt           time.Time
	cpu, mem         *ring
	rx, tx           *ring
	memLimit         int64
}

type inspectInfo struct {
	state        string
	startedAt    *time.Time
	finishedAt   *time.Time
	restartCount int
	hasHealth    bool
	restartPol   string
}

type updateEntry struct {
	available bool
	checkedAt time.Time
}

type hostState struct {
	prevCPU    hosts.CPUSample
	spark      *ring
	containers []model.Container
	listedAt   time.Time
	stats      map[string]*ctrStats
	inspect    map[string]*inspectInfo
	updates    map[string]updateEntry // image ref → result
	dockerRoot string
	dockerVer  string
	polling    bool
	wasOffline bool
}

// Monitor is the polling engine and container cache.
type Monitor struct {
	db       *db.DB
	hosts    *hosts.Store
	conns    *hosts.Manager
	settings *settings.Store
	alerts   *alerts.Engine

	// OnContainerStarted is called (async) when a container starts; used for auto monitors.
	OnContainerStarted func(hostID, name string, hasHealth bool)

	mu    sync.RWMutex
	state map[string]*hostState

	expMu    sync.Mutex
	expected map[string]time.Time // host|container → time of a Dockhand-initiated action

	evMu     sync.Mutex
	evCancel map[string]context.CancelFunc
	stopping map[string]time.Time // host|container → time a stop/kill event was seen

	refreshMu sync.Mutex
	refreshQ  map[string]bool
}

func New(pool *db.DB, hs *hosts.Store, conns *hosts.Manager, st *settings.Store, al *alerts.Engine) *Monitor {
	return &Monitor{db: pool, hosts: hs, conns: conns, settings: st, alerts: al,
		state: map[string]*hostState{}, expected: map[string]time.Time{}, evCancel: map[string]context.CancelFunc{},
		stopping: map[string]time.Time{}, refreshQ: map[string]bool{}}
}

func (m *Monitor) hs(id string) *hostState {
	s := m.state[id]
	if s == nil {
		s = &hostState{spark: newRing(sparkLen), stats: map[string]*ctrStats{}, inspect: map[string]*inspectInfo{}, updates: map[string]updateEntry{}}
		m.state[id] = s
	}
	return s
}

// Run starts the poll loop, event supervisor and update checker until ctx ends.
func (m *Monitor) Run(ctx context.Context) {
	go m.eventsSupervisor(ctx)
	go m.updateLoop(ctx)
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	m.pollAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.pollAll(ctx)
		}
	}
}

func (m *Monitor) pollAll(ctx context.Context) {
	list, err := m.hosts.List(ctx)
	if err != nil {
		slog.Warn("poller: list hosts", "err", err)
		return
	}
	for _, r := range list {
		m.mu.Lock()
		s := m.hs(r.ID)
		busy := s.polling
		s.polling = true
		m.mu.Unlock()
		if busy {
			continue // previous poll still running (slow host) — never stack polls
		}
		go func(r hosts.Record) {
			defer func() {
				m.mu.Lock()
				if s := m.state[r.ID]; s != nil {
					s.polling = false
				}
				m.mu.Unlock()
			}()
			m.PollHost(ctx, r)
		}(r)
	}
}

// PollHost polls one host now.
func (m *Monitor) PollHost(parent context.Context, r hosts.Record) {
	ctx, cancel := context.WithTimeout(parent, pollTimeout)
	defer cancel()
	err := m.poll(ctx, r)
	if err == nil || parent.Err() != nil {
		return
	}
	m.conns.Invalidate(r.ID)
	retries := m.settings.Get().Uptime.Retries
	if retries < 1 {
		retries = 1
	}
	msg := err.Error()
	n, status, ferr := m.hosts.RecordFailure(context.Background(), r.ID, msg, retries)
	if ferr != nil {
		slog.Warn("poller: record failure", "host", r.Name, "err", ferr)
		return
	}
	slog.Debug("poll failed", "host", r.Name, "fails", n, "err", msg)
	if status == "offline" {
		m.mu.Lock()
		s := m.hs(r.ID)
		first := !s.wasOffline
		s.wasOffline = true
		m.mu.Unlock()
		if first && r.Monitored {
			m.alerts.Raise(context.Background(), alerts.Spec{Key: "host_down:" + r.ID, Severity: "crit", Kind: "host_down",
				Title: r.Name + " is offline", Text: fmt.Sprintf("Dockhand could not reach %s after %d attempts: %s", r.Name, n, msg),
				HostID: r.ID, Action: "Open host", Href: "/hosts/" + r.ID, Pref: alerts.PrefHostDown})
		}
	}
}

func (m *Monitor) poll(ctx context.Context, r hosts.Record) error {
	conn, err := m.conns.Get(ctx, r.ID)
	if err != nil {
		return err
	}
	cli := conn.Docker()

	m.mu.RLock()
	s := m.state[r.ID]
	root, ver := "", ""
	if s != nil {
		root, ver = s.dockerRoot, s.dockerVer
	}
	m.mu.RUnlock()
	if root == "" || ver == "" {
		info, err := cli.Info(ctx)
		if err != nil {
			return fmt.Errorf("docker: %w", err)
		}
		root, ver = info.DockerRootDir, info.ServerVersion
	}
	diskPath := root
	if conn.Local() {
		diskPath = "/" // Docker's root dir is on the host, not inside Dockhand's container.
	}
	res, err := conn.Exec(ctx, hosts.ProbeScript(diskPath), nil)
	if err != nil {
		return fmt.Errorf("probe: %w", err)
	}
	probe, err := hosts.ParseProbe(res.Stdout)
	if err != nil {
		return err
	}

	list, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return fmt.Errorf("docker: %w", err)
	}
	ctrs := make([]model.Container, 0, len(list))
	for _, c := range list {
		ctrs = append(ctrs, FromSummary(r.ID, c))
	}
	m.enrich(ctx, r.ID, cli, ctrs)

	// CPU from the delta with the previous sample.
	m.mu.Lock()
	s = m.hs(r.ID)
	s.dockerRoot, s.dockerVer = root, ver
	cpu := hosts.CPUPercent(s.prevCPU, probe.CPU)
	s.prevCPU = probe.CPU
	if cpu < 0 {
		cpu = r.CPU
	} else {
		s.spark.push(cpu)
	}
	s.containers = ctrs
	s.listedAt = time.Now()
	wasOffline := s.wasOffline || r.Status == "offline"
	s.wasOffline = false
	m.applyCachedUpdates(s, ctrs)
	m.mu.Unlock()

	memPct, diskPct := 0.0, 0.0
	if probe.MemTotal > 0 {
		memPct = round1(float64(probe.MemUsed) / float64(probe.MemTotal) * 100)
	}
	if probe.DiskTotal > 0 {
		diskPct = round1(float64(probe.DiskUsed) / float64(probe.DiskTotal) * 100)
	}
	status := "online"
	unhealthy := []model.Container{}
	for _, c := range ctrs {
		if c.Health == "unhealthy" || c.State == "restarting" {
			unhealthy = append(unhealthy, c)
		}
	}
	if cpu >= thresholdPct || memPct >= thresholdPct || diskPct >= thresholdPct || len(unhealthy) > 0 {
		status = "degraded"
	}
	bg := context.Background()
	if err := m.hosts.RecordSuccess(bg, r.ID, status, hosts.Facts{OS: probe.OS, Kernel: probe.Kernel, DockerVersion: ver,
		CPUCores: probe.Cores, UptimeSec: probe.UptimeSec, CPU: cpu, MemUsed: probe.MemUsed, MemTotal: probe.MemTotal,
		DiskUsed: probe.DiskUsed, DiskTotal: probe.DiskTotal}); err != nil {
		slog.Warn("poller: record success", "host", r.Name, "err", err)
	}
	if err := m.hosts.InsertMetric(bg, r.ID, cpu, memPct, diskPct); err != nil {
		slog.Warn("poller: insert metric", "host", r.Name, "err", err)
	}
	m.evaluateAlerts(bg, r, wasOffline, memPct, diskPct, probe, ctrs)
	return nil
}

// enrich fills timestamps from (cached) inspects and cpu/mem from one-shot stats.
func (m *Monitor) enrich(ctx context.Context, hostID string, cli interface {
	ContainerInspect(context.Context, string) (container.InspectResponse, error)
	ContainerStatsOneShot(context.Context, string) (container.StatsResponseReader, error)
}, ctrs []model.Container) {
	m.mu.RLock()
	s := m.state[hostID]
	need := []int{}
	for i, c := range ctrs {
		var ii *inspectInfo
		if s != nil {
			ii = s.inspect[c.ID]
		}
		if ii == nil || ii.state != c.State {
			need = append(need, i)
		}
	}
	m.mu.RUnlock()

	fresh := make(map[string]*inspectInfo)
	var fmu sync.Mutex
	parallel(ctx, len(need), statsWorkers, func(k int) {
		c := ctrs[need[k]]
		ictx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ins, err := cli.ContainerInspect(ictx, c.ID)
		if err != nil || ins.ContainerJSONBase == nil || ins.State == nil {
			return
		}
		ii := &inspectInfo{state: c.State, startedAt: ParseDockerTime(ins.State.StartedAt),
			finishedAt: ParseDockerTime(ins.State.FinishedAt), restartCount: ins.RestartCount}
		if ins.Config != nil && ins.Config.Healthcheck != nil && len(ins.Config.Healthcheck.Test) > 0 && ins.Config.Healthcheck.Test[0] != "NONE" {
			ii.hasHealth = true
		}
		if ins.HostConfig != nil {
			ii.restartPol = string(ins.HostConfig.RestartPolicy.Name)
		}
		fmu.Lock()
		fresh[c.ID] = ii
		fmu.Unlock()
	})

	running := []int{}
	for i, c := range ctrs {
		if c.State == "running" {
			running = append(running, i)
		}
	}
	type sample struct {
		cpuTotal, sys uint64
		online        uint32
		mem, limit    uint64
		rx, tx        uint64
		at            time.Time
	}
	samples := make([]*sample, len(running))
	parallel(ctx, len(running), statsWorkers, func(k int) {
		c := ctrs[running[k]]
		sctx, cancel := context.WithTimeout(ctx, 6*time.Second)
		defer cancel()
		rd, err := cli.ContainerStatsOneShot(sctx, c.ID)
		if err != nil {
			return
		}
		defer rd.Body.Close()
		var st container.StatsResponse
		if json.NewDecoder(rd.Body).Decode(&st) != nil {
			return
		}
		mem := st.MemoryStats.Usage
		if v, ok := st.MemoryStats.Stats["inactive_file"]; ok && v < mem {
			mem -= v
		} else if v, ok := st.MemoryStats.Stats["total_inactive_file"]; ok && v < mem {
			mem -= v
		}
		smp := &sample{cpuTotal: st.CPUStats.CPUUsage.TotalUsage, sys: st.CPUStats.SystemUsage, online: st.CPUStats.OnlineCPUs,
			mem: mem, limit: st.MemoryStats.Limit, at: time.Now()}
		if smp.online == 0 {
			smp.online = uint32(len(st.CPUStats.CPUUsage.PercpuUsage))
		}
		for _, n := range st.Networks {
			smp.rx += n.RxBytes
			smp.tx += n.TxBytes
		}
		samples[k] = smp
	})

	m.mu.Lock()
	defer m.mu.Unlock()
	s = m.hs(hostID)
	for id, ii := range fresh {
		s.inspect[id] = ii
	}
	alive := map[string]bool{}
	for i := range ctrs {
		c := &ctrs[i]
		alive[c.ID] = true
		if ii := s.inspect[c.ID]; ii != nil {
			c.StartedAt = ii.startedAt
			c.FinishedAt = ii.finishedAt
			c.RestartPolicy = ii.restartPol
			if c.State == "running" || c.State == "created" {
				c.FinishedAt = nil
			}
		}
	}
	for k, idx := range running {
		smp := samples[k]
		c := &ctrs[idx]
		cs := s.stats[c.ID]
		if cs == nil {
			cs = &ctrStats{cpu: newRing(historyLen), mem: newRing(historyLen), rx: newRing(historyLen), tx: newRing(historyLen)}
			s.stats[c.ID] = cs
		}
		if smp == nil {
			c.CPU, c.MemUsed, c.MemLimit = cs.cpu.last(), int64(cs.mem.last()), cs.memLimit
			continue
		}
		if !cs.prevAt.IsZero() && smp.cpuTotal >= cs.prevCPU && smp.sys > cs.prevSys {
			cpuPct := float64(smp.cpuTotal-cs.prevCPU) / float64(smp.sys-cs.prevSys) * float64(smp.online) * 100
			cs.cpu.push(round1(cpuPct))
			dt := smp.at.Sub(cs.prevAt).Seconds()
			if dt > 0 && smp.rx >= cs.prevRx && smp.tx >= cs.prevTx {
				cs.rx.push(float64(int64(float64(smp.rx-cs.prevRx) / dt)))
				cs.tx.push(float64(int64(float64(smp.tx-cs.prevTx) / dt)))
			}
		}
		cs.mem.push(float64(smp.mem))
		cs.prevCPU, cs.prevSys, cs.prevRx, cs.prevTx, cs.prevAt = smp.cpuTotal, smp.sys, smp.rx, smp.tx, smp.at
		cs.memLimit = int64(smp.limit)
		c.CPU, c.MemUsed, c.MemLimit = cs.cpu.last(), int64(smp.mem), int64(smp.limit)
	}
	for id := range s.stats {
		if !alive[id] {
			delete(s.stats, id)
		}
	}
	for id := range s.inspect {
		if !alive[id] {
			delete(s.inspect, id)
		}
	}
}

// parallel runs fn(0..n-1) with at most workers goroutines.
func parallel(ctx context.Context, n, workers int, fn func(i int)) {
	if n == 0 {
		return
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(i int) {
			defer func() { <-sem; wg.Done() }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

func (m *Monitor) evaluateAlerts(ctx context.Context, r hosts.Record, wasOffline bool, memPct, diskPct float64, p hosts.Probe, ctrs []model.Container) {
	if wasOffline {
		if m.alerts.Resolve(ctx, "host_down:"+r.ID) {
			m.alerts.Event(ctx, alerts.Spec{Key: "host_up:" + r.ID, Severity: "ok", Kind: "host_up", Title: r.Name + " recovered",
				Text: r.Name + " is reachable again.", HostID: r.ID, Action: "Open host", Href: "/hosts/" + r.ID, Pref: alerts.PrefHostDown})
		}
	}
	if diskPct >= thresholdPct {
		sev := "warn"
		if diskPct >= 95 {
			sev = "crit"
		}
		m.alerts.Raise(ctx, alerts.Spec{Key: "disk:" + r.ID, Severity: sev, Kind: "disk", Title: fmt.Sprintf("Disk %.0f%% full on %s", diskPct, r.Name),
			Text:   fmt.Sprintf("%s of %s used. Pruning unused images and build cache usually frees space.", humanBytes(p.DiskUsed), humanBytes(p.DiskTotal)),
			HostID: r.ID, Action: "Clean up", Href: "/hosts/" + r.ID + "?tab=images", Pref: alerts.PrefDiskSpace})
	} else if diskPct > 0 && diskPct < thresholdPct-2 {
		m.alerts.Resolve(ctx, "disk:"+r.ID)
	}
	if memPct >= thresholdPct {
		m.alerts.Raise(ctx, alerts.Spec{Key: "mem:" + r.ID, Severity: "warn", Kind: "mem", Title: fmt.Sprintf("Memory %.0f%% used on %s", memPct, r.Name),
			Text: fmt.Sprintf("%s of %s in use.", humanBytes(p.MemUsed), humanBytes(p.MemTotal)), HostID: r.ID, Action: "Open host",
			Href: "/hosts/" + r.ID + "?tab=containers", Pref: alerts.PrefDiskSpace})
	} else if memPct > 0 && memPct < thresholdPct-2 {
		m.alerts.Resolve(ctx, "mem:"+r.ID)
	}
	keep := []string{}
	exitedKeep := []string{}
	for _, c := range ctrs {
		if c.Health == "unhealthy" {
			key := "unhealthy:" + r.ID + ":" + c.Name
			keep = append(keep, key)
			m.alerts.Raise(ctx, alerts.Spec{Key: key, Severity: "warn", Kind: "unhealthy", Title: c.Name + " is unhealthy",
				Text: fmt.Sprintf("The health check of %s on %s is failing.", c.Name, r.Name), HostID: r.ID, Action: "Open logs",
				Href: logsHref(r.ID, c.Name), Pref: alerts.PrefUnhealthy})
		}
		if c.State == "exited" || c.State == "dead" {
			exitedKeep = append(exitedKeep, "container_exited:"+r.ID+":"+c.Name)
		}
	}
	m.alerts.ResolvePrefix(ctx, "unhealthy:"+r.ID+":", keep)
	m.alerts.ResolvePrefix(ctx, "container_exited:"+r.ID+":", exitedKeep)
}

func logsHref(hostID, name string) string {
	return "/hosts/" + hostID + "?tab=logs&c=" + name
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// ─── Cache accessors ─────────────────────────────────────────────────────────

// HostView fills runtime fields (container counts, updates, spark) on a host record.
func (m *Monitor) HostView(r hosts.Record) model.Host {
	h := r.Host
	h.Spark = []float64{}
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.state[r.ID]
	if s == nil {
		return h
	}
	h.Spark = s.spark.snapshot()
	for _, c := range s.containers {
		h.Total++
		if c.State == "running" {
			h.Running++
		}
		if c.Update.Available {
			h.Updates++
		}
	}
	return h
}

// Containers returns the cached containers of a host, sorted by name.
func (m *Monitor) Containers(hostID string) []model.Container {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.state[hostID]
	if s == nil {
		return []model.Container{}
	}
	out := make([]model.Container, len(s.containers))
	copy(out, s.containers)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	for i := range out {
		out[i].Ports = append([]model.PortMap{}, out[i].Ports...)
	}
	return out
}

// HasCache reports whether the host has been listed at least once.
func (m *Monitor) HasCache(hostID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.state[hostID]
	return s != nil && !s.listedAt.IsZero()
}

// AllContainers returns cached containers of every host.
func (m *Monitor) AllContainers(hostIDs []string) []model.Container {
	out := []model.Container{}
	for _, id := range hostIDs {
		out = append(out, m.Containers(id)...)
	}
	return out
}

// Container finds a cached container by id, short id or name.
func (m *Monitor) Container(hostID, ref string) (model.Container, bool) {
	for _, c := range m.Containers(hostID) {
		if c.ID == ref || c.Name == ref || (len(ref) >= 6 && strings.HasPrefix(c.ID, ref)) {
			return c, true
		}
	}
	return model.Container{}, false
}

// History returns the container's recent stats samples.
func (m *Monitor) History(hostID, containerID string) model.History {
	h := model.History{CPU: []float64{}, Mem: []float64{}, NetRx: []float64{}, NetTx: []float64{}}
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.state[hostID]
	if s == nil {
		return h
	}
	cs := s.stats[containerID]
	if cs == nil {
		return h
	}
	return model.History{CPU: cs.cpu.snapshot(), Mem: cs.mem.snapshot(), NetRx: cs.rx.snapshot(), NetTx: cs.tx.snapshot()}
}

// RestartCount returns the cached restart count (-1 unknown).
func (m *Monitor) HasHealthcheck(hostID, containerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s := m.state[hostID]; s != nil {
		if ii := s.inspect[containerID]; ii != nil {
			return ii.hasHealth
		}
	}
	return false
}

// Forget drops all state for a deleted host.
func (m *Monitor) Forget(hostID string) {
	m.mu.Lock()
	delete(m.state, hostID)
	m.mu.Unlock()
	m.stopEvents(hostID)
	m.conns.Invalidate(hostID)
}

// Refresh re-lists a host's containers now (after an action), keeping stats.
func (m *Monitor) Refresh(ctx context.Context, hostID string) {
	conn, err := m.conns.Get(ctx, hostID)
	if err != nil {
		return
	}
	cli := conn.Docker()
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	list, err := cli.ContainerList(lctx, container.ListOptions{All: true})
	if err != nil {
		return
	}
	ctrs := make([]model.Container, 0, len(list))
	for _, c := range list {
		ctrs = append(ctrs, FromSummary(hostID, c))
	}
	// Invalidate inspect cache for changed states, reuse stats.
	m.enrichLight(lctx, hostID, cli, ctrs)
	m.mu.Lock()
	s := m.hs(hostID)
	s.containers = ctrs
	s.listedAt = time.Now()
	m.applyCachedUpdates(s, ctrs)
	m.mu.Unlock()
}

// enrichLight fills timestamps and last-known stats without sampling new stats.
func (m *Monitor) enrichLight(ctx context.Context, hostID string, cli interface {
	ContainerInspect(context.Context, string) (container.InspectResponse, error)
}, ctrs []model.Container) {
	m.mu.RLock()
	s := m.state[hostID]
	need := []int{}
	for i, c := range ctrs {
		if s == nil || s.inspect[c.ID] == nil || s.inspect[c.ID].state != c.State {
			need = append(need, i)
		}
	}
	m.mu.RUnlock()
	fresh := map[string]*inspectInfo{}
	var fmu sync.Mutex
	parallel(ctx, len(need), statsWorkers, func(k int) {
		c := ctrs[need[k]]
		ins, err := cli.ContainerInspect(ctx, c.ID)
		if err != nil || ins.ContainerJSONBase == nil || ins.State == nil {
			return
		}
		ii := &inspectInfo{state: c.State, startedAt: ParseDockerTime(ins.State.StartedAt), finishedAt: ParseDockerTime(ins.State.FinishedAt),
			restartCount: ins.RestartCount}
		if ins.Config != nil && ins.Config.Healthcheck != nil && len(ins.Config.Healthcheck.Test) > 0 && ins.Config.Healthcheck.Test[0] != "NONE" {
			ii.hasHealth = true
		}
		fmu.Lock()
		fresh[c.ID] = ii
		fmu.Unlock()
	})
	m.mu.Lock()
	defer m.mu.Unlock()
	s = m.hs(hostID)
	for id, ii := range fresh {
		s.inspect[id] = ii
	}
	for i := range ctrs {
		c := &ctrs[i]
		if ii := s.inspect[c.ID]; ii != nil {
			c.StartedAt, c.FinishedAt = ii.startedAt, ii.finishedAt
			c.RestartPolicy = ii.restartPol
			if c.State == "running" || c.State == "created" {
				c.FinishedAt = nil
			}
		}
		if cs := s.stats[c.ID]; cs != nil && c.State == "running" {
			c.CPU, c.MemUsed, c.MemLimit = cs.cpu.last(), int64(cs.mem.last()), cs.memLimit
		}
	}
}

// queueRefresh debounces a container refresh after Docker events.
func (m *Monitor) queueRefresh(ctx context.Context, hostID string) {
	m.refreshMu.Lock()
	if m.refreshQ[hostID] {
		m.refreshMu.Unlock()
		return
	}
	m.refreshQ[hostID] = true
	m.refreshMu.Unlock()
	time.AfterFunc(1500*time.Millisecond, func() {
		m.refreshMu.Lock()
		delete(m.refreshQ, hostID)
		m.refreshMu.Unlock()
		if ctx.Err() == nil {
			m.Refresh(ctx, hostID)
		}
	})
}

// ─── Container events ───────────────────────────────────────────────────────

// RecordAction stores a Dockhand-initiated container action in the event log
// and suppresses the matching Docker events for a short while.
func (m *Monitor) RecordAction(ctx context.Context, hostID, container, action, actor string) {
	m.expMu.Lock()
	m.expected[hostID+"|"+container] = time.Now()
	m.expMu.Unlock()
	if _, err := m.db.Exec(ctx, `INSERT INTO container_events (host_id, container, action, actor) VALUES ($1, $2, $3, $4)`,
		hostID, container, action, actor); err != nil {
		slog.Warn("record container event", "err", err)
	}
}

func (m *Monitor) expectedRecently(hostID, container string) bool {
	m.expMu.Lock()
	defer m.expMu.Unlock()
	t, ok := m.expected[hostID+"|"+container]
	if ok && time.Since(t) > expectedActionT {
		delete(m.expected, hostID+"|"+container)
		return false
	}
	return ok
}

// Events returns the last n events for a container.
func (m *Monitor) Events(ctx context.Context, hostID, container string, n int) ([]model.ContainerEvent, error) {
	rows, err := m.db.Query(ctx, `SELECT at, action, actor FROM container_events WHERE host_id::text = $1 AND container = $2
		ORDER BY at DESC LIMIT $3`, hostID, container, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ContainerEvent{}
	for rows.Next() {
		var e model.ContainerEvent
		if err := rows.Scan(&e.T, &e.Action, &e.By); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneEvents deletes container events older than 30 days.
func (m *Monitor) PruneEvents(ctx context.Context) error {
	_, err := m.db.Exec(ctx, `DELETE FROM container_events WHERE at < now() - interval '30 days'`)
	return err
}
