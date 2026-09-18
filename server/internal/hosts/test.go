package hosts

import (
	"context"
	"fmt"
	"time"

	"dockhand/internal/model"
	"dockhand/internal/util"
)

var testLabels = []string{"Resolving address", "Opening SSH connection", "Authenticating", "Checking Docker", "Reading host info"}

// TestOutcome is the result of a connection test.
type TestOutcome struct {
	Result  model.HostTestResult
	Facts   Facts
	HostKey string // presented host key (for pinning)
}

// Test runs the five connection-test steps against a target. Nothing is cached.
func (m *Manager) Test(ctx context.Context, t Target) TestOutcome {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	steps := make([]model.TestStep, 0, 5)
	out := TestOutcome{}
	fail := func(err error) TestOutcome {
		// Mark remaining steps skipped.
		for i := len(steps); i < len(testLabels); i++ {
			steps = append(steps, model.TestStep{Label: testLabels[i], Status: "skipped"})
		}
		out.Result = model.HostTestResult{OK: false, Steps: steps, Error: err.Error()}
		return out
	}

	if t.Method == "local" {
		for _, l := range testLabels[:3] {
			steps = append(steps, model.TestStep{Label: l, Sub: "local socket " + remoteSock, Status: "skipped"})
		}
		return m.testDocker(ctx, &Conn{target: t, lastUsed: time.Now()}, steps, out)
	}
	phaseIdx := map[string]int{"resolve": 0, "connect": 1, "auth": 2}
	info, sshc, err := m.DialSSH(ctx, t, func(phase string, ms int64, sub string, err error) {
		st := model.TestStep{Label: testLabels[phaseIdx[phase]], Sub: sub, Status: "done", Ms: ms}
		if err != nil {
			st.Status, st.Sub = "failed", err.Error()
		}
		steps = append(steps, st)
	})
	if err != nil {
		return fail(err)
	}
	defer sshc.Close()
	out.HostKey = info.HostKey
	return m.testDocker(ctx, &Conn{target: t, ssh: sshc, lastUsed: time.Now()}, steps, out)
}

func (m *Manager) testDocker(ctx context.Context, c *Conn, steps []model.TestStep, out TestOutcome) TestOutcome {
	fail := func(err error) TestOutcome {
		for i := len(steps); i < len(testLabels); i++ {
			steps = append(steps, model.TestStep{Label: testLabels[i], Status: "skipped"})
		}
		out.Result = model.HostTestResult{OK: false, Steps: steps, Error: err.Error()}
		return out
	}
	// Checking Docker
	start := time.Now()
	dc, err := newDockerClient(c.target, c.ssh)
	if err != nil {
		steps = append(steps, model.TestStep{Label: testLabels[3], Status: "failed", Sub: err.Error(), Ms: time.Since(start).Milliseconds()})
		return fail(err)
	}
	c.docker = dc
	defer dc.Close()
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	ver, err := dc.ServerVersion(dctx)
	cancel()
	if err != nil {
		err = fmt.Errorf("cannot talk to Docker at %s: %v (is Docker installed and is %s in the docker group?)", remoteSock, err, c.target.User)
		steps = append(steps, model.TestStep{Label: testLabels[3], Status: "failed", Sub: err.Error(), Ms: time.Since(start).Milliseconds()})
		return fail(err)
	}
	out.Facts.DockerVersion = ver.Version
	steps = append(steps, model.TestStep{Label: testLabels[3], Status: "done", Ms: time.Since(start).Milliseconds(),
		Sub: fmt.Sprintf("Docker %s · API %s", ver.Version, ver.APIVersion)})

	// Reading host info
	start = time.Now()
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	res, err := c.Exec(pctx, ProbeScript("/"), nil)
	cancel()
	var p Probe
	if err == nil {
		p, err = ParseProbe(res.Stdout)
	}
	if err != nil {
		err = fmt.Errorf("reading host info: %v", err)
		steps = append(steps, model.TestStep{Label: testLabels[4], Status: "failed", Sub: err.Error(), Ms: time.Since(start).Milliseconds()})
		return fail(err)
	}
	out.Facts = Facts{OS: p.OS, Kernel: p.Kernel, DockerVersion: ver.Version, CPUCores: p.Cores, UptimeSec: p.UptimeSec,
		MemUsed: p.MemUsed, MemTotal: p.MemTotal, DiskUsed: p.DiskUsed, DiskTotal: p.DiskTotal}
	osName := p.OS
	if osName == "" {
		osName = "Linux"
	}
	steps = append(steps, model.TestStep{Label: testLabels[4], Status: "done", Ms: time.Since(start).Milliseconds(),
		Sub: fmt.Sprintf("%s · kernel %s · %d cores · %s RAM", osName, p.Kernel, p.Cores, util.HumanBytes(p.MemTotal))})
	out.Result = model.HostTestResult{OK: true, Steps: steps}
	return out
}
