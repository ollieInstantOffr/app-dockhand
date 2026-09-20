// Package jobs runs long-running work (deploys, pulls, updates, backups) in the
// background, recording steps and log lines to the `deployments` table.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/util"
)

const (
	flushEvery = 300 * time.Millisecond
	maxLog     = 5000
	jobTimeout = 45 * time.Minute
)

// Spec describes a job to start.
type Spec struct {
	Kind    string
	Title   string
	HostID  string // "" = none
	StackID string // "" = none
	Actor   string
	Plan    []string // step labels shown as pending up front
}

// Func is the work of a job. Returning an error fails the job.
type Func func(ctx context.Context, j *Job) error

// FinishHook is called after every job completes.
type FinishHook func(j model.Job, actor string)

type Runner struct {
	db   *db.DB
	root context.Context

	mu     sync.Mutex
	active map[string]*Job
	hooks  []FinishHook
	wg     sync.WaitGroup
}

func NewRunner(root context.Context, pool *db.DB) *Runner {
	return &Runner{db: pool, root: root, active: map[string]*Job{}}
}

// Running reports whether a job of this kind is in progress.
func (r *Runner) Running(kind string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, j := range r.active {
		if j.spec.Kind == kind {
			return true
		}
	}
	return false
}

// OnFinish registers a hook called when any job finishes.
func (r *Runner) OnFinish(h FinishHook) { r.hooks = append(r.hooks, h) }

// Job is a running job. All methods are safe for concurrent use.
type Job struct {
	r     *Runner
	id    string
	spec  Spec
	start time.Time

	mu        sync.Mutex
	steps     []model.JobStep
	stepStart []time.Time
	cur       int // index of the running step, -1 = none
	log       []model.JobLogLine
	result    map[string]any
	stackID   string
	status    string
	finished  *time.Time
	dirty     bool
	lastFlush time.Time
	flushing  bool
	scheduled bool
}

// ID returns the job id.
func (j *Job) ID() string { return j.id }

// Actor returns who started the job.
func (j *Job) Actor() string { return j.spec.Actor }

// Start creates the deployments row and runs fn in a goroutine.
func (r *Runner) Start(spec Spec, fn Func) (string, error) {
	j := &Job{r: r, spec: spec, start: time.Now(), cur: -1, result: map[string]any{}, status: "running", log: []model.JobLogLine{}}
	for _, l := range spec.Plan {
		j.steps = append(j.steps, model.JobStep{Label: l, Status: "pending"})
		j.stepStart = append(j.stepStart, time.Time{})
	}
	if j.steps == nil {
		j.steps = []model.JobStep{}
	}
	ctx, cancel := context.WithTimeout(r.root, 10*time.Second)
	defer cancel()
	err := r.db.QueryRow(ctx, `INSERT INTO deployments (kind, title, host_id, stack_id, status, steps, actor, started_at)
		VALUES ($1, $2, $3, $4, 'running', $5, $6, $7) RETURNING id::text`,
		spec.Kind, spec.Title, nullable(spec.HostID), nullable(spec.StackID), db.JSON(j.steps), spec.Actor, j.start).Scan(&j.id)
	if err != nil {
		return "", fmt.Errorf("create job: %w", err)
	}
	if spec.HostID != "" {
		j.result["hostId"] = spec.HostID
	}
	r.mu.Lock()
	r.active[j.id] = j
	r.mu.Unlock()
	r.wg.Add(1)
	go r.run(j, fn)
	return j.id, nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (r *Runner) run(j *Job, fn Func) {
	defer r.wg.Done()
	ctx, cancel := context.WithTimeout(r.root, jobTimeout)
	defer cancel()
	var err error
	func() {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("internal error: %v", p)
				slog.Error("job panic", "job", j.id, "panic", p)
			}
		}()
		err = fn(ctx, j)
	}()
	j.mu.Lock()
	now := time.Now()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil {
			err = fmt.Errorf("job timed out after %s", jobTimeout)
		}
		if errors.Is(err, context.Canceled) && r.root.Err() != nil {
			err = errors.New("Dockhand was shut down while this job was running")
		}
		if j.cur >= 0 {
			j.steps[j.cur].Status = "failed"
			j.steps[j.cur].T = util.Elapsed(now.Sub(j.stepStart[j.cur]))
			if j.steps[j.cur].Sub == "" {
				j.steps[j.cur].Sub = util.Truncate(err.Error(), 200)
			}
		}
		for i := range j.steps {
			if j.steps[i].Status == "pending" {
				j.steps[i].Status = "skipped"
			}
		}
		j.appendLog("error", err.Error())
		j.status = "failed"
	} else {
		if j.cur >= 0 {
			j.steps[j.cur].Status = "done"
			j.steps[j.cur].T = util.Elapsed(now.Sub(j.stepStart[j.cur]))
		}
		for i := range j.steps {
			if j.steps[i].Status == "pending" {
				j.steps[i].Status = "skipped"
			}
		}
		j.status = "success"
	}
	j.cur = -1
	j.finished = &now
	j.mu.Unlock()
	j.flush(true)
	snap := j.Snapshot()
	r.mu.Lock()
	delete(r.active, j.id)
	r.mu.Unlock()
	for _, h := range r.hooks {
		func() {
			defer func() { _ = recover() }()
			h(snap, j.spec.Actor)
		}()
	}
}

// Wait blocks until running jobs finish or ctx expires (graceful shutdown).
func (r *Runner) Wait(ctx context.Context) {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// Step finishes the running step (done) and starts the step with this label
// (reusing a planned pending step when one exists).
func (j *Job) Step(label, sub string) {
	j.mu.Lock()
	now := time.Now()
	j.finishCurrent(now, "done")
	idx := -1
	for i, s := range j.steps {
		if s.Label == label && s.Status == "pending" {
			idx = i
			break
		}
	}
	if idx < 0 {
		j.steps = append(j.steps, model.JobStep{Label: label})
		j.stepStart = append(j.stepStart, now)
		idx = len(j.steps) - 1
	}
	j.steps[idx].Status = "running"
	j.steps[idx].Sub = sub
	j.stepStart[idx] = now
	j.cur = idx
	j.dirty = true
	j.mu.Unlock()
	j.flush(true)
}

func (j *Job) finishCurrent(now time.Time, status string) {
	if j.cur >= 0 {
		j.steps[j.cur].Status = status
		j.steps[j.cur].T = util.Elapsed(now.Sub(j.stepStart[j.cur]))
		j.cur = -1
	}
}

// Sub updates the running step's sub text.
func (j *Job) Sub(sub string) {
	j.mu.Lock()
	if j.cur >= 0 {
		j.steps[j.cur].Sub = sub
		j.dirty = true
	}
	j.mu.Unlock()
	j.flush(false)
}

// Done marks the running step done without starting another.
func (j *Job) Done(sub string) {
	j.mu.Lock()
	if j.cur >= 0 && sub != "" {
		j.steps[j.cur].Sub = sub
	}
	j.finishCurrent(time.Now(), "done")
	j.dirty = true
	j.mu.Unlock()
	j.flush(true)
}

// Skip marks a (planned or new) step as skipped.
func (j *Job) Skip(label, sub string) {
	j.mu.Lock()
	j.finishCurrent(time.Now(), "done")
	found := false
	for i := range j.steps {
		if j.steps[i].Label == label && j.steps[i].Status == "pending" {
			j.steps[i].Status, j.steps[i].Sub = "skipped", sub
			found = true
			break
		}
	}
	if !found {
		j.steps = append(j.steps, model.JobStep{Label: label, Sub: sub, Status: "skipped"})
		j.stepStart = append(j.stepStart, time.Now())
	}
	j.dirty = true
	j.mu.Unlock()
	j.flush(true)
}

// Fail marks the running step failed (the job continues; return an error to fail the job).
func (j *Job) Fail(sub string) {
	j.mu.Lock()
	if j.cur >= 0 {
		j.steps[j.cur].Sub = sub
	}
	j.finishCurrent(time.Now(), "failed")
	j.dirty = true
	j.mu.Unlock()
	j.flush(true)
}

// Log appends a log line. Levels: info ok warn error cmd muted.
func (j *Job) Log(level, text string) {
	j.mu.Lock()
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		j.appendLog(level, line)
	}
	j.mu.Unlock()
	j.flush(false)
}

// Logf is Log with formatting.
func (j *Job) Logf(level, format string, args ...any) { j.Log(level, fmt.Sprintf(format, args...)) }

func (j *Job) appendLog(level, text string) {
	if len(j.log) >= maxLog {
		// Keep the tail; drop a chunk from the front and leave a marker.
		keep := j.log[len(j.log)-maxLog+500:]
		j.log = append([]model.JobLogLine{{Text: "… earlier output truncated", Level: "muted"}}, keep...)
	}
	j.log = append(j.log, model.JobLogLine{Text: text, Level: level})
	j.dirty = true
}

// Set stores a result value.
func (j *Job) Set(k string, v any) {
	j.mu.Lock()
	j.result[k] = v
	j.dirty = true
	j.mu.Unlock()
}

// SetStack links the job to a stack row.
func (j *Job) SetStack(id string) {
	j.mu.Lock()
	j.stackID = id
	j.dirty = true
	j.mu.Unlock()
	j.flush(true)
}

// Snapshot returns the current state.
func (j *Job) Snapshot() model.Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := model.Job{ID: j.id, Kind: j.spec.Kind, Title: j.spec.Title, Status: j.status, Actor: j.spec.Actor,
		Steps: append([]model.JobStep{}, j.steps...), Log: append([]model.JobLogLine{}, j.log...),
		Result: map[string]any{}, StartedAt: j.start, FinishedAt: j.finished}
	for k, v := range j.result {
		out.Result[k] = v
	}
	if j.spec.HostID != "" {
		h := j.spec.HostID
		out.HostID = &h
	}
	// Show live elapsed time for the running step.
	if j.cur >= 0 {
		out.Steps[j.cur].T = util.Elapsed(time.Since(j.stepStart[j.cur]))
	}
	return out
}

// flush writes the job to the database, throttled unless force is set.
func (j *Job) flush(force bool) {
	j.mu.Lock()
	if !j.dirty || j.flushing || (!force && time.Since(j.lastFlush) < flushEvery) {
		schedule := j.dirty && !j.scheduled
		if schedule {
			j.scheduled = true
		}
		j.mu.Unlock()
		if schedule {
			// Trailing flush so the last lines land promptly.
			time.AfterFunc(flushEvery, func() {
				j.mu.Lock()
				j.scheduled = false
				j.mu.Unlock()
				j.flush(false)
			})
		}
		return
	}
	j.flushing = true
	j.dirty = false
	j.lastFlush = time.Now()
	steps, _ := json.Marshal(j.steps)
	logb, _ := json.Marshal(j.log)
	res, _ := json.Marshal(j.result)
	status, finished, stackID := j.status, j.finished, j.stackID
	j.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := j.r.db.Exec(ctx, `UPDATE deployments SET steps=$2, log=$3, result=$4, status=$5, finished_at=$6,
		stack_id=coalesce($7::uuid, stack_id) WHERE id = $1`, j.id, steps, logb, res, status, finished, nullable(stackID))
	cancel()
	if err != nil {
		slog.Warn("flush job", "job", j.id, "err", err)
	}
	j.mu.Lock()
	j.flushing = false
	again := j.dirty && j.finished != nil
	j.mu.Unlock()
	if again {
		j.flush(true)
	}
}

// Get returns a job, preferring live in-memory state.
func (r *Runner) Get(ctx context.Context, id string) (model.Job, error) {
	r.mu.Lock()
	j := r.active[id]
	r.mu.Unlock()
	if j != nil {
		return j.Snapshot(), nil
	}
	var out model.Job
	var steps, logb, res []byte
	err := r.db.QueryRow(ctx, `SELECT id::text, kind, title, host_id::text, status, coalesce(actor, ''), steps, log, result, started_at, finished_at
		FROM deployments WHERE id::text = $1`, id).
		Scan(&out.ID, &out.Kind, &out.Title, &out.HostID, &out.Status, &out.Actor, &steps, &logb, &res, &out.StartedAt, &out.FinishedAt)
	if err != nil {
		if db.IsNoRows(err) {
			return out, errors.New("job not found")
		}
		return out, err
	}
	_ = json.Unmarshal(steps, &out.Steps)
	_ = json.Unmarshal(logb, &out.Log)
	_ = json.Unmarshal(res, &out.Result)
	out.Steps, out.Log = util.NZ(out.Steps), util.NZ(out.Log)
	if out.Result == nil {
		out.Result = map[string]any{}
	}
	return out, nil
}

// List returns recent jobs without their logs.
func (r *Runner) List(ctx context.Context, limit int) ([]model.Job, error) {
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	rows, err := r.db.Query(ctx, `SELECT id::text, kind, title, host_id::text, status, coalesce(actor, ''), steps, result, started_at, finished_at
		FROM deployments ORDER BY started_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Job{}
	for rows.Next() {
		var j model.Job
		var steps, res []byte
		if err := rows.Scan(&j.ID, &j.Kind, &j.Title, &j.HostID, &j.Status, &j.Actor, &steps, &res, &j.StartedAt, &j.FinishedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(steps, &j.Steps)
		_ = json.Unmarshal(res, &j.Result)
		j.Steps, j.Log = util.NZ(j.Steps), []model.JobLogLine{}
		if j.Result == nil {
			j.Result = map[string]any{}
		}
		r.mu.Lock()
		if live := r.active[j.ID]; live != nil {
			s := live.Snapshot()
			j.Steps, j.Status = s.Steps, s.Status
		}
		r.mu.Unlock()
		out = append(out, j)
	}
	return out, rows.Err()
}

// FailStale marks jobs left running by a previous process as failed.
func (r *Runner) FailStale(ctx context.Context) error {
	_, err := r.db.Exec(ctx, `UPDATE deployments SET status = 'failed', finished_at = now(),
		log = log || '[{"text":"Dockhand restarted while this job was running","level":"error"}]'::jsonb
		WHERE status = 'running'`)
	return err
}

// Prune deletes finished jobs older than the retention period.
func (r *Runner) Prune(ctx context.Context, keep time.Duration) error {
	_, err := r.db.Exec(ctx, `DELETE FROM deployments WHERE status <> 'running' AND started_at < $1
		AND id NOT IN (SELECT id FROM deployments ORDER BY started_at DESC LIMIT 200)`, time.Now().Add(-keep))
	return err
}
