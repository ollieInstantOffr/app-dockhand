package api

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"dockhand/internal/hosts"
)

// Fleet-wide lists: the same per-host lists, gathered from every reachable host
// in parallel. A host that fails is reported in `errors` instead of failing the
// whole list.

type fleetItem[T any] struct {
	HostID   string `json:"hostId"`
	HostName string `json:"hostName"`
	Item     T      `json:"item"`
}

type fleetError struct {
	HostID   string `json:"hostId"`
	HostName string `json:"hostName"`
	Error    string `json:"error"`
}

type fleetList[T any] struct {
	Items  []fleetItem[T] `json:"items"`
	Errors []fleetError   `json:"errors"`
	// Skipped hosts are offline or not yet connected.
	Skipped []fleetError `json:"skipped"`
}

func gather[T any](s *Server, w http.ResponseWriter, r *http.Request, fetch func(ctx context.Context, hostID string) ([]T, error)) {
	list, err := s.Hosts.List(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	out := fleetList[T]{Items: []fleetItem[T]{}, Errors: []fleetError{}, Skipped: []fleetError{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, h := range list {
		if h.Status == "offline" || h.Status == "pending" {
			out.Skipped = append(out.Skipped, fleetError{HostID: h.ID, HostName: h.Name, Error: "host is " + h.Status})
			continue
		}
		wg.Add(1)
		go func(h hosts.Record) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			items, err := fetch(ctx, h.ID)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				out.Errors = append(out.Errors, fleetError{HostID: h.ID, HostName: h.Name, Error: err.Error()})
				return
			}
			for _, it := range items {
				out.Items = append(out.Items, fleetItem[T]{HostID: h.ID, HostName: h.Name, Item: it})
			}
		}(h)
	}
	wg.Wait()
	// Stable order: by host name; each host's list keeps its own order.
	sort.SliceStable(out.Items, func(i, j int) bool { return out.Items[i].HostName < out.Items[j].HostName })
	sort.Slice(out.Errors, func(i, j int) bool { return out.Errors[i].HostName < out.Errors[j].HostName })
	ok(w, out)
}

// fleetMetrics is the fleet-wide load history behind the pulse panel.
func (s *Server) fleetMetrics(w http.ResponseWriter, r *http.Request) {
	rng := parseRange(r.URL.Query().Get("range"), 24*time.Hour)
	if rng > 24*time.Hour {
		rng = 24 * time.Hour
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	m, err := s.Hosts.FleetMetrics(ctx, rng)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, m)
}

func (s *Server) fleetStacks(w http.ResponseWriter, r *http.Request) { gather(s, w, r, s.Stacks.List) }
func (s *Server) fleetImages(w http.ResponseWriter, r *http.Request) { gather(s, w, r, s.Ops.Images) }
func (s *Server) fleetVolumes(w http.ResponseWriter, r *http.Request) {
	gather(s, w, r, s.Ops.Volumes)
}
func (s *Server) fleetNetworks(w http.ResponseWriter, r *http.Request) {
	gather(s, w, r, s.Ops.Networks)
}
