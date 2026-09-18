// Package model defines the JSON shapes of the Dockhand API. They mirror
// web/lib/types.ts exactly (camelCase keys). Slices must be non-nil when
// serialised so that they render as [] rather than null.
package model

import "time"

// ─── Auth / account ────────────────────────────────────────────────────────

type User struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	Theme     string    `json:"theme"`
	CreatedAt time.Time `json:"createdAt"`
}

type AuthState struct {
	SetupRequired bool   `json:"setupRequired"`
	User          *User  `json:"user"`
	Version       string `json:"version"`
}

type SessionInfo struct {
	ID         string    `json:"id"`
	Device     string    `json:"device"`
	IP         string    `json:"ip"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	Current    bool      `json:"current"`
}

type Account struct {
	User     User          `json:"user"`
	Sessions []SessionInfo `json:"sessions"`
}

type SshKeyInfo struct {
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
}

// ─── Hosts ─────────────────────────────────────────────────────────────────

type Host struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Address       string     `json:"address"`
	Port          int        `json:"port"`
	User          string     `json:"user"`
	Method        string     `json:"method"`
	Color         string     `json:"color"`
	Status        string     `json:"status"`
	OS            string     `json:"os"`
	Kernel        string     `json:"kernel"`
	DockerVersion string     `json:"dockerVersion"`
	CPUCores      int        `json:"cpuCores"`
	UptimeSec     int64      `json:"uptimeSec"`
	CPU           float64    `json:"cpu"`
	Mem           float64    `json:"mem"`
	Disk          float64    `json:"disk"`
	MemUsed       int64      `json:"memUsed"`
	MemTotal      int64      `json:"memTotal"`
	DiskUsed      int64      `json:"diskUsed"`
	DiskTotal     int64      `json:"diskTotal"`
	Running       int        `json:"running"`
	Total         int        `json:"total"`
	Updates       int        `json:"updates"`
	Spark         []float64  `json:"spark"`
	LastSeenAt    *time.Time `json:"lastSeenAt"`
	LastError     string     `json:"lastError"`
	FailCount     int        `json:"failCount"`
	Monitored     bool       `json:"monitored"`
	McpExposed    bool       `json:"mcpExposed"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type HostInput struct {
	Name     string `json:"name"`
	Address  string `json:"address"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Method   string `json:"method"`
	Password string `json:"password"`
	Color    string `json:"color"`
}

type TestStep struct {
	Label  string `json:"label"`
	Sub    string `json:"sub"`
	Status string `json:"status"`
	Ms     int64  `json:"ms"`
}

type HostTestResult struct {
	OK    bool       `json:"ok"`
	Steps []TestStep `json:"steps"`
	Error string     `json:"error"`
	Host  *Host      `json:"host,omitempty"`
}

type MetricPoint struct {
	At   time.Time `json:"at"`
	CPU  float64   `json:"cpu"`
	Mem  float64   `json:"mem"`
	Disk float64   `json:"disk"`
}

// ─── Containers ────────────────────────────────────────────────────────────

type PortMap struct {
	IP        string `json:"ip"`
	Host      int    `json:"host"`
	Container int    `json:"container"`
	Proto     string `json:"proto"`
}

type UpdateInfo struct {
	Available bool       `json:"available"`
	Tag       string     `json:"tag"`
	CheckedAt *time.Time `json:"checkedAt"`
}

type Container struct {
	ID         string     `json:"id"`
	ShortID    string     `json:"shortId"`
	HostID     string     `json:"hostId"`
	Name       string     `json:"name"`
	Image      string     `json:"image"`
	ImageID    string     `json:"imageId"`
	State      string     `json:"state"`
	Status     string     `json:"status"`
	Health     string     `json:"health"`
	ExitCode   int        `json:"exitCode"`
	Stack      string     `json:"stack"`
	Service    string     `json:"service"`
	CPU        float64    `json:"cpu"`
	MemUsed    int64      `json:"memUsed"`
	MemLimit   int64      `json:"memLimit"`
	Ports      []PortMap  `json:"ports"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Update     UpdateInfo `json:"update"`

	// Internal (not serialised).
	Labels     map[string]string `json:"-"`
	WorkingDir string            `json:"-"`
}

type KV struct {
	K string `json:"k"`
	V string `json:"v"`
}

type EnvVar struct {
	K      string `json:"k"`
	V      string `json:"v"`
	Secret bool   `json:"secret"`
}

type Mount struct {
	Type string `json:"type"`
	Src  string `json:"src"`
	Dst  string `json:"dst"`
	Mode string `json:"mode"`
}

type ContainerNetwork struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	GW     string `json:"gw"`
	Driver string `json:"driver"`
}

type ContainerEvent struct {
	T      time.Time `json:"t"`
	Action string    `json:"action"`
	By     string    `json:"by"`
}

type History struct {
	CPU   []float64 `json:"cpu"`
	Mem   []float64 `json:"mem"`
	NetRx []float64 `json:"netRx"`
	NetTx []float64 `json:"netTx"`
}

type ContainerDetail struct {
	Container
	Command        string             `json:"command"`
	Entrypoint     string             `json:"entrypoint"`
	Workdir        string             `json:"workdir"`
	Hostname       string             `json:"hostname"`
	RestartPolicy  string             `json:"restartPolicy"`
	RestartCount   int                `json:"restartCount"`
	Env            []EnvVar           `json:"env"`
	Labels         []KV               `json:"labels"`
	Mounts         []Mount            `json:"mounts"`
	Networks       []ContainerNetwork `json:"networks"`
	HealthCmd      string             `json:"healthCmd"`
	HealthInterval string             `json:"healthInterval"`
	History        History            `json:"history"`
	Events         []ContainerEvent   `json:"events"`
}

type RunContainerInput struct {
	HostID  string `json:"hostId"`
	Image   string `json:"image"`
	Name    string `json:"name"`
	Restart string `json:"restart"`
	Ports   []struct {
		Host      string `json:"host"`
		Container string `json:"container"`
	} `json:"ports"`
	Volumes []struct {
		Src string `json:"src"`
		Dst string `json:"dst"`
	} `json:"volumes"`
	Env     []KV   `json:"env"`
	Network string `json:"network"`
	Traefik bool   `json:"traefik"`
}

// ─── Stacks ────────────────────────────────────────────────────────────────

type StackService struct {
	Name        string    `json:"name"`
	Image       string    `json:"image"`
	State       string    `json:"state"`
	ContainerID string    `json:"containerId"`
	Ports       []PortMap `json:"ports"`
	Health      string    `json:"health"`
}

type Stack struct {
	ID           *string        `json:"id"`
	HostID       string         `json:"hostId"`
	Name         string         `json:"name"`
	Path         string         `json:"path"`
	ComposeFile  string         `json:"composeFile"`
	Status       string         `json:"status"`
	Managed      bool           `json:"managed"`
	Source       string         `json:"source"`
	Repo         string         `json:"repo"`
	Branch       string         `json:"branch"`
	SHA          string         `json:"sha"`
	AutoDeploy   bool           `json:"autoDeploy"`
	LastDeployAt *time.Time     `json:"lastDeployAt"`
	Services     []StackService `json:"services"`
}

type ComposeServiceInfo struct {
	Name  string   `json:"name"`
	Image string   `json:"image"`
	Ports []string `json:"ports"`
}

type ComposeValidation struct {
	OK       bool                 `json:"ok"`
	Error    string               `json:"error"`
	Line     int                  `json:"line"`
	Services []ComposeServiceInfo `json:"services"`
}

type ComposeTemplate struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Content string `json:"content"`
}

// ─── Storage / networks ────────────────────────────────────────────────────

type Image struct {
	ID         string    `json:"id"`
	ShortID    string    `json:"shortId"`
	Repo       string    `json:"repo"`
	Tag        string    `json:"tag"`
	Size       int64     `json:"size"`
	CreatedAt  time.Time `json:"createdAt"`
	Containers int       `json:"containers"`
	Dangling   bool      `json:"dangling"`
}

type Volume struct {
	Name       string     `json:"name"`
	Driver     string     `json:"driver"`
	Mountpoint string     `json:"mountpoint"`
	Size       int64      `json:"size"`
	Containers []string   `json:"containers"`
	CreatedAt  *time.Time `json:"createdAt"`
}

type NetworkMember struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	IP    string `json:"ip"`
	State string `json:"state"`
}

type Network struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Driver     string          `json:"driver"`
	Scope      string          `json:"scope"`
	Subnet     string          `json:"subnet"`
	Gateway    string          `json:"gateway"`
	Internal   bool            `json:"internal"`
	Attachable bool            `json:"attachable"`
	System     bool            `json:"system"`
	Members    []NetworkMember `json:"members"`
	CreatedAt  *time.Time      `json:"createdAt"`
}

type NetworkInput struct {
	Name       string `json:"name"`
	Driver     string `json:"driver"`
	Subnet     string `json:"subnet"`
	Gateway    string `json:"gateway"`
	Internal   bool   `json:"internal"`
	Attachable bool   `json:"attachable"`
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

type JobStep struct {
	Label  string `json:"label"`
	Sub    string `json:"sub"`
	Status string `json:"status"`
	T      string `json:"t"`
}

type JobLogLine struct {
	Text  string `json:"text"`
	Level string `json:"level"`
}

type Job struct {
	ID         string         `json:"id"`
	Kind       string         `json:"kind"`
	Title      string         `json:"title"`
	HostID     *string        `json:"hostId"`
	Status     string         `json:"status"`
	Steps      []JobStep      `json:"steps"`
	Log        []JobLogLine   `json:"log"`
	Result     map[string]any `json:"result"`
	StartedAt  time.Time      `json:"startedAt"`
	FinishedAt *time.Time     `json:"finishedAt"`
}

type JobRef struct {
	JobID string `json:"jobId"`
}

// ─── GitHub ────────────────────────────────────────────────────────────────

type GitAccount struct {
	ID               string     `json:"id"`
	Login            string     `json:"login"`
	Kind             string     `json:"kind"`
	Method           string     `json:"method"`
	ServerURL        string     `json:"serverUrl"`
	Enabled          bool       `json:"enabled"`
	RepoAccess       string     `json:"repoAccess"`
	SelectedRepos    []string   `json:"selectedRepos"`
	Webhook          bool       `json:"webhook"`
	Color            string     `json:"color"`
	RepoCount        int        `json:"repoCount"`
	ComposeRepoCount int        `json:"composeRepoCount"`
	LastSyncAt       *time.Time `json:"lastSyncAt"`
	LastError        string     `json:"lastError"`
	Status           string     `json:"status"`
}

type GitAccountInput struct {
	Kind           string `json:"kind"`
	Method         string `json:"method"`
	Token          string `json:"token"`
	ServerURL      string `json:"serverUrl"`
	DeviceCode     string `json:"deviceCode"`
	InstallationID int64  `json:"installationId"`
}

type DeviceFlowStart struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expiresIn"`
}

type Repo struct {
	ID            int64      `json:"id"`
	AccountID     string     `json:"accountId"`
	Owner         string     `json:"owner"`
	Name          string     `json:"name"`
	FullName      string     `json:"fullName"`
	Private       bool       `json:"private"`
	Description   string     `json:"description"`
	DefaultBranch string     `json:"defaultBranch"`
	ComposeFiles  []string   `json:"composeFiles"`
	PushedAt      *time.Time `json:"pushedAt"`
	DeployedOn    string     `json:"deployedOn"`
}

type Branch struct {
	Name      string     `json:"name"`
	SHA       string     `json:"sha"`
	UpdatedAt *time.Time `json:"updatedAt"`
	IsDefault bool       `json:"isDefault"`
}

type InspectService struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	Meta  string `json:"meta"`
}

type InspectEnv struct {
	K        string `json:"k"`
	V        string `json:"v"`
	Required bool   `json:"required"`
	Comment  string `json:"comment"`
}

type RepoInspect struct {
	ComposeFiles []string         `json:"composeFiles"`
	Services     []InspectService `json:"services"`
	Env          []InspectEnv     `json:"env"`
}

type GitDeployInput struct {
	AccountID   string `json:"accountId"`
	Owner       string `json:"owner"`
	Name        string `json:"name"`
	Branch      string `json:"branch"`
	ComposeFile string `json:"composeFile"`
	HostID      string `json:"hostId"`
	Path        string `json:"path"`
	Env         []KV   `json:"env"`
	AutoDeploy  bool   `json:"autoDeploy"`
}

// ─── Uptime ────────────────────────────────────────────────────────────────

type UptimeBar struct {
	Status string    `json:"status"`
	Pct    float64   `json:"pct"`
	From   time.Time `json:"from"`
	To     time.Time `json:"to"`
}

type MonitorView struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Type        string      `json:"type"`
	HostID      *string     `json:"hostId"`
	HostName    string      `json:"hostName"`
	Target      string      `json:"target"`
	Enabled     bool        `json:"enabled"`
	Auto        bool        `json:"auto"`
	Status      string      `json:"status"`
	Pct         float64     `json:"pct"`
	LatencyMs   float64     `json:"latencyMs"`
	Incidents   int         `json:"incidents"`
	LastCheckAt *time.Time  `json:"lastCheckAt"`
	Bars        []UptimeBar `json:"bars"`
}

type IncidentView struct {
	ID          string     `json:"id"`
	MonitorID   string     `json:"monitorId"`
	Target      string     `json:"target"`
	Status      string     `json:"status"`
	Message     string     `json:"message"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt"`
	DurationSec int64      `json:"durationSec"`
}

type UptimeStats struct {
	Overall       float64 `json:"overall"`
	MonitorsUp    int     `json:"monitorsUp"`
	MonitorsTotal int     `json:"monitorsTotal"`
	AvgLatencyMs  float64 `json:"avgLatencyMs"`
	Incidents     int     `json:"incidents"`
	OpenIncidents int     `json:"openIncidents"`
}

type UptimeOverview struct {
	Window    string         `json:"window"`
	Stats     UptimeStats    `json:"stats"`
	Hosts     []MonitorView  `json:"hosts"`
	Monitors  []MonitorView  `json:"monitors"`
	Incidents []IncidentView `json:"incidents"`
}

type MonitorInput struct {
	Name   string  `json:"name"`
	Type   string  `json:"type"`
	HostID *string `json:"hostId"`
	Target string  `json:"target"`
	Expect string  `json:"expect"`
}

type PublicMonitor struct {
	Name   string      `json:"name"`
	Status string      `json:"status"`
	Pct    float64     `json:"pct"`
	Bars   []UptimeBar `json:"bars"`
}

type PublicStatus struct {
	Title    string          `json:"title"`
	Overall  float64         `json:"overall"`
	Status   string          `json:"status"`
	Monitors []PublicMonitor `json:"monitors"`
}

// ─── Alerts & notifications ────────────────────────────────────────────────

type Alert struct {
	ID           string     `json:"id"`
	Severity     string     `json:"severity"`
	Kind         string     `json:"kind"`
	Title        string     `json:"title"`
	Text         string     `json:"text"`
	HostID       *string    `json:"hostId"`
	HostName     string     `json:"hostName"`
	Action       string     `json:"action"`
	Href         string     `json:"href"`
	CreatedAt    time.Time  `json:"createdAt"`
	Read         bool       `json:"read"`
	SnoozedUntil *time.Time `json:"snoozedUntil"`
	Resolved     bool       `json:"resolved"`
}

type NotificationChannel struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Name      string            `json:"name"`
	Config    map[string]string `json:"config"`
	Enabled   bool              `json:"enabled"`
	CreatedAt time.Time         `json:"createdAt"`
}

// ─── MCP ───────────────────────────────────────────────────────────────────

type McpTool struct {
	Name   string `json:"name"`
	Group  string `json:"group"`
	Desc   string `json:"desc"`
	Writes bool   `json:"writes"`
}

type ApiKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Client     string     `json:"client"`
	Prefix     string     `json:"prefix"`
	Scope      string     `json:"scope"`
	Groups     []string   `json:"groups"`
	HostIDs    []string   `json:"hostIds"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	Revoked    bool       `json:"revoked"`
	CreatedAt  time.Time  `json:"createdAt"`
}

type ApiKeyWithSecret struct {
	ApiKey
	Key string `json:"key"`
}

type ApiKeyInput struct {
	Name        string   `json:"name"`
	Client      string   `json:"client"`
	Scope       string   `json:"scope"`
	Groups      []string `json:"groups"`
	HostIDs     []string `json:"hostIds"`
	ExpiresDays int      `json:"expiresDays"`
}

type McpActivity struct {
	ID     int64     `json:"id"`
	Client string    `json:"client"`
	Tool   string    `json:"tool"`
	Detail string    `json:"detail"`
	OK     bool      `json:"ok"`
	At     time.Time `json:"at"`
}

type McpStatus struct {
	URL        string    `json:"url"`
	CallsToday int       `json:"callsToday"`
	Tools      []McpTool `json:"tools"`
	// Port is the dedicated MCP listener port (0 = served on Dockhand's own port);
	// ListenError is set when that listener couldn't be started.
	Port        int    `json:"port"`
	ListenError string `json:"listenError,omitempty"`
	// PublishedPort is the port docker-compose publishes for MCP (DOCKHAND_MCP_PORT; 0 = none).
	PublishedPort int `json:"publishedPort"`
}

// ─── System ────────────────────────────────────────────────────────────────

type SystemSource struct {
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
	SHA    string `json:"sha"`
	Path   string `json:"path"`
}

type UpdateHistory struct {
	ID          string    `json:"id"`
	Version     string    `json:"version"`
	FromVersion string    `json:"fromVersion"`
	Status      string    `json:"status"`
	Note        string    `json:"note"`
	At          time.Time `json:"at"`
}

type SystemInfo struct {
	Version         string          `json:"version"`
	Latest          string          `json:"latest"`
	UpdateAvailable bool            `json:"updateAvailable"`
	ReleasedAt      *time.Time      `json:"releasedAt"`
	Notes           []string        `json:"notes"`
	ChangelogURL    string          `json:"changelogUrl"`
	CheckedAt       *time.Time      `json:"checkedAt"`
	CanSelfUpdate   bool            `json:"canSelfUpdate"`
	Source          SystemSource    `json:"source"`
	History         []UpdateHistory `json:"history"`
	// Mode is "git" when Dockhand runs from a git checkout (updates = new commits on
	// its branch) and "release" otherwise (updates = GitHub releases).
	Mode          string `json:"mode"`
	CurrentCommit string `json:"currentCommit,omitempty"` // short sha the stack was built from (git mode)
	CheckError    string `json:"checkError,omitempty"`    // why the last check failed, if it did
}

// ─── Overview ──────────────────────────────────────────────────────────────

type AttentionItem struct {
	Severity string  `json:"severity"`
	HostID   *string `json:"hostId"`
	Host     string  `json:"host"`
	Text     string  `json:"text"`
	Action   string  `json:"action"`
	Href     string  `json:"href"`
}

type Overview struct {
	Hosts        int             `json:"hosts"`
	Online       int             `json:"online"`
	Running      int             `json:"running"`
	Total        int             `json:"total"`
	Updates      int             `json:"updates"`
	UnreadAlerts int             `json:"unreadAlerts"`
	Attention    []AttentionItem `json:"attention"`
}

// ─── v2 design additions ───────────────────────────────────────────────────

// DiskCategory is one slice of the Docker disk usage breakdown.
type DiskCategory struct {
	Key         string `json:"key"` // images | containers | volumes | buildCache
	Label       string `json:"label"`
	Size        int64  `json:"size"`
	Reclaimable int64  `json:"reclaimable"`
	Count       int    `json:"count"`
	Active      int    `json:"active"`
}

// DiskUsage is GET /api/hosts/:id/disk.
type DiskUsage struct {
	Root        string         `json:"root"`
	Used        int64          `json:"used"`
	Capacity    int64          `json:"capacity"`
	Categories  []DiskCategory `json:"categories"`
	Reclaimable int64          `json:"reclaimable"`
}

// PortPatch replaces host port From with To.
type PortPatch struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// DeployPatch holds the form values a fix applies.
type DeployPatch struct {
	Name  string      `json:"name,omitempty"`
	Path  string      `json:"path,omitempty"`
	Ports []PortPatch `json:"ports,omitempty"`
	Env   []KV        `json:"env,omitempty"`
}

// DeployFix is a one-click fix for a DeployIssue.
type DeployFix struct {
	Label string      `json:"label"`
	Patch DeployPatch `json:"patch"`
}

// DeployIssue is one pre-flight problem.
type DeployIssue struct {
	Field    string     `json:"field"`
	Text     string     `json:"text"`
	Severity string     `json:"severity"` // crit | warn
	Fix      *DeployFix `json:"fix,omitempty"`
}

// PortPair is a host → container port mapping from a deploy form.
type PortPair struct {
	Host      string `json:"host"`
	Container string `json:"container"`
}

// DeployCheckInput is the POST /api/deploy/check body.
type DeployCheckInput struct {
	Kind        string     `json:"kind"` // git | image | compose
	HostID      string     `json:"hostId"`
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	Image       string     `json:"image"`
	Ports       []PortPair `json:"ports"`
	Env         []KV       `json:"env"`
	RequiredEnv []string   `json:"requiredEnv"`
	ComposeFile string     `json:"composeFile"`
}

// DeployCheckResult is the POST /api/deploy/check response.
type DeployCheckResult struct {
	OK     bool          `json:"ok"`
	Issues []DeployIssue `json:"issues"`
}

// DryRunResult is returned by the dry-run endpoints.
type DryRunResult struct {
	OK      bool   `json:"ok"`
	Command string `json:"command"`
	Output  string `json:"output"`
}
