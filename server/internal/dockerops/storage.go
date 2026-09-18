package dockerops

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"

	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/util"
)

// ─── Volumes ────────────────────────────────────────────────────────────────

// Volumes lists volumes with sizes and users.
func (s *Service) Volumes(ctx context.Context, hostID string) ([]model.Volume, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	cli := conn.Docker()
	lctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	vl, err := cli.VolumeList(lctx, volume.ListOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	sizes := map[string]int64{}
	// DiskUsage can be slow on big hosts; bound it separately.
	dctx, dcancel := context.WithTimeout(ctx, 15*time.Second)
	if du, err := cli.DiskUsage(dctx, types.DiskUsageOptions{Types: []types.DiskUsageObject{types.VolumeObject}}); err == nil {
		for _, v := range du.Volumes {
			if v != nil && v.UsageData != nil {
				sizes[v.Name] = v.UsageData.Size
			}
		}
	}
	dcancel()
	users := map[string][]string{}
	if ctrs, err := cli.ContainerList(lctx, container.ListOptions{All: true}); err == nil {
		for _, c := range ctrs {
			for _, m := range c.Mounts {
				if m.Type == "volume" && m.Name != "" {
					users[m.Name] = append(users[m.Name], monitor.ContainerName(c.Names))
				}
			}
		}
	}
	out := []model.Volume{}
	for _, v := range vl.Volumes {
		if v == nil {
			continue
		}
		size, ok := sizes[v.Name]
		if !ok {
			size = -1
		}
		out = append(out, model.Volume{Name: v.Name, Driver: v.Driver, Mountpoint: v.Mountpoint, Size: size,
			Containers: util.NZ(users[v.Name]), CreatedAt: monitor.ParseDockerTime(v.CreatedAt)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// RemoveVolume deletes a volume.
func (s *Service) RemoveVolume(ctx context.Context, hostID, name string) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return wrap(conn.Docker().VolumeRemove(rctx, name, false))
}

// BackupVolumes tars volumes into BackupsDir on the host via a helper alpine container (job).
func (s *Service) BackupVolumes(ctx context.Context, hostID string, names []string, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		vols, err := s.Volumes(ctx, hostID)
		if err != nil {
			return "", err
		}
		for _, v := range vols {
			names = append(names, v.Name)
		}
	}
	if len(names) == 0 {
		return "", bad("there are no volumes to back up")
	}
	dir := s.cfg.BackupsDir
	return s.jobs.Start(jobs.Spec{Kind: "backup", Title: fmt.Sprintf("Back up %d volume%s on %s", len(names), plural(len(names)), rec.Name),
		HostID: hostID, Actor: actor, Plan: []string{"Preparing helper image"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			cli := conn.Docker()
			j.Step("Preparing helper image", "alpine:3")
			if _, err := cli.ImageInspect(ctx, "alpine:3"); err != nil {
				if err := s.Pull(ctx, conn, "alpine:3", j.Log); err != nil {
					return err
				}
			}
			ts := time.Now().UTC().Format("20060102-150405")
			files := []string{}
			failed := 0
			for _, v := range names {
				j.Step("Backing up "+v, "")
				file := fmt.Sprintf("%s-%s.tar.gz", v, ts)
				cfg := &container.Config{Image: "alpine:3", Cmd: []string{"tar", "czf", "/backup/" + file, "-C", "/data", "."},
					Labels: map[string]string{"dockhand.helper": "backup"}}
				hc := &container.HostConfig{Binds: []string{v + ":/data:ro", dir + ":/backup"}}
				created, err := cli.ContainerCreate(ctx, cfg, hc, nil, nil, "")
				if err == nil {
					err = cli.ContainerStart(ctx, created.ID, container.StartOptions{})
					if err == nil {
						waitC, errC := cli.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
						select {
						case w := <-waitC:
							if w.StatusCode != 0 {
								err = fmt.Errorf("tar exited with status %d", w.StatusCode)
							}
						case e := <-errC:
							err = e
						}
					}
					_ = cli.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})
				}
				if err != nil {
					j.Fail(cleanDockerErr(err))
					j.Logf("error", "%s: %s", v, cleanDockerErr(err))
					failed++
					continue
				}
				j.Done(dir + "/" + file)
				j.Logf("ok", "%s → %s/%s", v, dir, file)
				files = append(files, dir+"/"+file)
			}
			j.Set("files", files)
			if failed > 0 {
				return fmt.Errorf("%d of %d backups failed", failed, len(names))
			}
			return nil
		})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// ─── Networks ───────────────────────────────────────────────────────────────

var systemNetworks = map[string]bool{"bridge": true, "host": true, "none": true}

// Networks lists networks with their members.
func (s *Service) Networks(ctx context.Context, hostID string) ([]model.Network, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	cli := conn.Docker()
	lctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	list, err := cli.NetworkList(lctx, network.ListOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	states := map[string]string{}
	for _, c := range s.mon.Containers(hostID) {
		states[c.ID] = c.State
	}
	out := make([]model.Network, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, n := range list {
		out[i] = model.Network{ID: n.ID, Name: n.Name, Driver: n.Driver, Scope: n.Scope, Internal: n.Internal, Attachable: n.Attachable,
			System: systemNetworks[n.Name], Members: []model.NetworkMember{}, CreatedAt: util.TimePtr(n.Created)}
		if len(n.IPAM.Config) > 0 {
			out[i].Subnet, out[i].Gateway = n.IPAM.Config[0].Subnet, n.IPAM.Config[0].Gateway
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, id string) {
			defer func() { <-sem; wg.Done() }()
			ins, err := cli.NetworkInspect(lctx, id, network.InspectOptions{})
			if err != nil {
				return
			}
			members := []model.NetworkMember{}
			for cid, ep := range ins.Containers {
				ip := ep.IPv4Address
				if k := strings.Index(ip, "/"); k >= 0 {
					ip = ip[:k]
				}
				st := states[cid]
				if st == "" {
					st = "running"
				}
				members = append(members, model.NetworkMember{ID: cid, Name: ep.Name, IP: ip, State: st})
			}
			sort.Slice(members, func(a, b int) bool { return members[a].Name < members[b].Name })
			out[i].Members = members
			if out[i].Subnet == "" && len(ins.IPAM.Config) > 0 {
				out[i].Subnet, out[i].Gateway = ins.IPAM.Config[0].Subnet, ins.IPAM.Config[0].Gateway
			}
		}(i, n.ID)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool {
		if out[i].System != out[j].System {
			return out[i].System
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// CreateNetwork creates a network.
func (s *Service) CreateNetwork(ctx context.Context, hostID string, in model.NetworkInput) (model.Network, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || !containerNameRe.MatchString(in.Name) {
		return model.Network{}, bad("invalid network name")
	}
	switch in.Driver {
	case "":
		in.Driver = "bridge"
	case "bridge", "overlay", "macvlan", "ipvlan":
	default:
		return model.Network{}, bad("driver must be bridge, overlay, macvlan or ipvlan")
	}
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return model.Network{}, err
	}
	opts := network.CreateOptions{Driver: in.Driver, Internal: in.Internal, Attachable: in.Attachable,
		Labels: map[string]string{"dockhand.managed": "true"}}
	if in.Subnet != "" || in.Gateway != "" {
		opts.IPAM = &network.IPAM{Config: []network.IPAMConfig{{Subnet: strings.TrimSpace(in.Subnet), Gateway: strings.TrimSpace(in.Gateway)}}}
	}
	cctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	resp, err := conn.Docker().NetworkCreate(cctx, in.Name, opts)
	if err != nil {
		return model.Network{}, wrap(err)
	}
	now := time.Now()
	return model.Network{ID: resp.ID, Name: in.Name, Driver: in.Driver, Scope: "local", Subnet: in.Subnet, Gateway: in.Gateway,
		Internal: in.Internal, Attachable: in.Attachable, Members: []model.NetworkMember{}, CreatedAt: &now}, nil
}

// InspectNetwork returns the raw inspect JSON.
func (s *Service) InspectNetwork(ctx context.Context, hostID, id string) (json.RawMessage, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	ictx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	_, raw, err := conn.Docker().NetworkInspectWithRaw(ictx, id, network.InspectOptions{Verbose: true})
	if err != nil {
		return nil, wrap(err)
	}
	return raw, nil
}

// RemoveNetwork deletes a network.
func (s *Service) RemoveNetwork(ctx context.Context, hostID, id string) error {
	if systemNetworks[id] {
		return bad("the %s network is built in and can't be removed", id)
	}
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return wrap(conn.Docker().NetworkRemove(rctx, id))
}

// PruneNetworks removes unused networks.
func (s *Service) PruneNetworks(ctx context.Context, hostID string) ([]string, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	pctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	rep, err := conn.Docker().NetworksPrune(pctx, filters.NewArgs())
	if err != nil {
		return nil, wrap(err)
	}
	return util.NZ(rep.NetworksDeleted), nil
}

// ConnectNetwork attaches or detaches a container.
func (s *Service) ConnectNetwork(ctx context.Context, hostID, netID, ctr string, connect bool) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	if c, ok := s.mon.Container(hostID, ctr); ok {
		ctr = c.ID
	}
	cctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	if connect {
		err = conn.Docker().NetworkConnect(cctx, netID, ctr, nil)
	} else {
		err = conn.Docker().NetworkDisconnect(cctx, netID, ctr, false)
	}
	if err == nil {
		go s.mon.Refresh(context.Background(), hostID)
	}
	return wrap(err)
}

// ─── Host prune ─────────────────────────────────────────────────────────────

// PruneInput selects what to prune.
type PruneInput struct {
	Containers bool `json:"containers"`
	Images     bool `json:"images"`
	Networks   bool `json:"networks"`
	Volumes    bool `json:"volumes"`
	BuildCache bool `json:"buildCache"`
}

// PruneHost prunes the selected object types (job).
func (s *Service) PruneHost(ctx context.Context, hostID string, in PruneInput, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	if !in.Containers && !in.Images && !in.Networks && !in.Volumes && !in.BuildCache {
		return "", bad("select at least one thing to prune")
	}
	plan := []string{}
	add := func(b bool, l string) {
		if b {
			plan = append(plan, l)
		}
	}
	add(in.Containers, "Stopped containers")
	add(in.Images, "Unused images")
	add(in.Networks, "Unused networks")
	add(in.Volumes, "Unused volumes")
	add(in.BuildCache, "Build cache")
	return s.jobs.Start(jobs.Spec{Kind: "prune", Title: "Clean up " + rec.Name, HostID: hostID, Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			cli := conn.Docker()
			var total uint64
			if in.Containers {
				j.Step("Stopped containers", "")
				r, err := cli.ContainersPrune(ctx, filters.NewArgs())
				if err != nil {
					return wrap(err)
				}
				total += r.SpaceReclaimed
				j.Done(fmt.Sprintf("%d removed · %s", len(r.ContainersDeleted), util.HumanBytes(int64(r.SpaceReclaimed))))
				j.Logf("info", "removed %d stopped containers", len(r.ContainersDeleted))
			}
			if in.Images {
				j.Step("Unused images", "")
				r, err := cli.ImagesPrune(ctx, filters.NewArgs(filters.Arg("dangling", "false")))
				if err != nil {
					return wrap(err)
				}
				total += r.SpaceReclaimed
				j.Done(fmt.Sprintf("%d removed · %s", len(r.ImagesDeleted), util.HumanBytes(int64(r.SpaceReclaimed))))
				j.Logf("info", "removed %d image layers/tags", len(r.ImagesDeleted))
			}
			if in.Networks {
				j.Step("Unused networks", "")
				r, err := cli.NetworksPrune(ctx, filters.NewArgs())
				if err != nil {
					return wrap(err)
				}
				j.Done(fmt.Sprintf("%d removed", len(r.NetworksDeleted)))
				for _, n := range r.NetworksDeleted {
					j.Log("muted", "removed network "+n)
				}
			}
			if in.Volumes {
				j.Step("Unused volumes", "")
				// all=true: prune named volumes too, not just anonymous ones.
				r, err := cli.VolumesPrune(ctx, filters.NewArgs(filters.Arg("all", "true")))
				if err != nil {
					return wrap(err)
				}
				total += r.SpaceReclaimed
				j.Done(fmt.Sprintf("%d removed · %s", len(r.VolumesDeleted), util.HumanBytes(int64(r.SpaceReclaimed))))
				for _, v := range r.VolumesDeleted {
					j.Log("muted", "removed volume "+v)
				}
			}
			if in.BuildCache {
				j.Step("Build cache", "")
				r, err := cli.BuildCachePrune(ctx, build.CachePruneOptions{All: true})
				if err != nil {
					return wrap(err)
				}
				total += r.SpaceReclaimed
				j.Done(util.HumanBytes(int64(r.SpaceReclaimed)))
			}
			j.Logf("ok", "reclaimed %s", util.HumanBytes(int64(total)))
			j.Set("reclaimed", total)
			s.mon.Refresh(context.Background(), hostID)
			return nil
		})
}
