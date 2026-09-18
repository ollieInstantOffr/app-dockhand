package dockerops

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"

	"dockhand/internal/model"
	"dockhand/internal/util"
)

const (
	diskTTL     = 30 * time.Second
	diskTimeout = 10 * time.Second
)

type diskEntry struct {
	at  time.Time
	val model.DiskUsage
}

// diskCache keeps the last disk usage per host (system/df is expensive: it walks volumes).
type diskCache struct {
	mu sync.Mutex
	m  map[string]diskEntry
}

func (c *diskCache) get(hostID string) (model.DiskUsage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[hostID]
	if !ok || time.Since(e.at) > diskTTL {
		return model.DiskUsage{}, false
	}
	return e.val, true
}

func (c *diskCache) put(hostID string, v model.DiskUsage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]diskEntry{}
	}
	c.m[hostID] = diskEntry{at: time.Now(), val: v}
}

// DiskUsage returns the Docker disk usage breakdown of a host (cached for 30 s).
func (s *Service) DiskUsage(ctx context.Context, hostID string) (model.DiskUsage, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.DiskUsage{}, err
	}
	if v, ok := s.disk.get(rec.ID); ok {
		return v, nil
	}
	ctx, cancel := context.WithTimeout(ctx, diskTimeout)
	defer cancel()
	conn, err := s.Conn(ctx, rec.ID)
	if err != nil {
		return model.DiskUsage{}, err
	}
	cli := conn.Docker()

	// system/df and info+df run in parallel; df is best effort.
	var (
		root     string
		capacity int64
		wg       sync.WaitGroup
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		ictx, icancel := context.WithTimeout(ctx, 5*time.Second)
		defer icancel()
		info, err := cli.Info(ictx)
		if err != nil {
			return
		}
		root = info.DockerRootDir
		if root == "" {
			return
		}
		res, _ := conn.Exec(ictx, dfCommand(root), nil)
		capacity = ParseDfSize(res.Stdout)
	}()
	du, err := cli.DiskUsage(ctx, types.DiskUsageOptions{})
	wg.Wait()
	if err != nil {
		return model.DiskUsage{}, wrap(err)
	}
	out := SummarizeDisk(du)
	out.Root = root
	out.Capacity = capacity
	if out.Capacity <= 0 {
		out.Capacity = rec.DiskTotal
	}
	s.disk.put(rec.ID, out)
	return out, nil
}

// dfCommand prints the filesystem size of path twice: GNU `df -B1 --output=size`
// and POSIX `df -P -k` (for busybox / BSD), separated by a marker line.
func dfCommand(path string) string {
	q := util.Shq(path)
	return "df -B1 --output=size " + q + " 2>/dev/null | tail -n1; echo @@; df -P -k " + q + " 2>/dev/null | tail -n1; true"
}

// ParseDfSize reads the output of dfCommand and returns the size in bytes (0 if unknown).
func ParseDfSize(out string) int64 {
	gnu, posix, _ := strings.Cut(out, "@@")
	if f := strings.Fields(gnu); len(f) == 1 {
		if n, err := strconv.ParseInt(f[0], 10, 64); err == nil && n > 0 {
			return n
		}
	}
	// Filesystem 1024-blocks Used Available Capacity Mounted-on
	if f := strings.Fields(posix); len(f) >= 4 {
		if n, err := strconv.ParseInt(f[1], 10, 64); err == nil && n > 0 {
			return n * 1024
		}
	}
	return 0
}

// SummarizeDisk turns a system/df response into the DiskUsage categories.
func SummarizeDisk(du types.DiskUsage) model.DiskUsage {
	img := model.DiskCategory{Key: "images", Label: "Images"}
	var imgSum int64
	for _, i := range du.Images {
		if i == nil {
			continue
		}
		img.Count++
		imgSum += i.Size
		if i.Containers > 0 {
			img.Active++
			continue
		}
		unique := i.Size
		if i.SharedSize > 0 {
			unique -= i.SharedSize
		}
		if unique > 0 {
			img.Reclaimable += unique
		}
	}
	// LayersSize counts every layer once, however many images share it.
	img.Size = du.LayersSize
	if img.Size <= 0 {
		img.Size = imgSum
	}

	ctr := model.DiskCategory{Key: "containers", Label: "Containers"}
	for _, c := range du.Containers {
		if c == nil {
			continue
		}
		ctr.Count++
		ctr.Size += c.SizeRw
		if c.State == "running" {
			ctr.Active++
		} else {
			ctr.Reclaimable += c.SizeRw
		}
	}

	vol := model.DiskCategory{Key: "volumes", Label: "Volumes"}
	for _, v := range du.Volumes {
		if v == nil {
			continue
		}
		vol.Count++
		var size int64
		refs := int64(0)
		if v.UsageData != nil {
			if v.UsageData.Size > 0 {
				size = v.UsageData.Size
			}
			refs = v.UsageData.RefCount
		}
		vol.Size += size
		if refs > 0 {
			vol.Active++
		} else {
			vol.Reclaimable += size
		}
	}

	bc := model.DiskCategory{Key: "buildCache", Label: "Build cache"}
	for _, r := range du.BuildCache {
		if r == nil {
			continue
		}
		bc.Count++
		if r.InUse {
			bc.Active++
		}
		// Same accounting as `docker system df`: every record counts towards the
		// size, but shared ones aren't freed by a prune.
		bc.Size += r.Size
		if !r.InUse && !r.Shared {
			bc.Reclaimable += r.Size
		}
	}

	out := model.DiskUsage{Categories: []model.DiskCategory{img, ctr, vol, bc}}
	for i := range out.Categories {
		c := &out.Categories[i]
		if c.Reclaimable > c.Size {
			c.Reclaimable = c.Size
		}
		out.Used += c.Size
		out.Reclaimable += c.Reclaimable
	}
	return out
}
