package mcp

// Tool groups.
const (
	GroupHosts      = "Hosts"
	GroupContainers = "Containers"
	GroupLogs       = "Logs"
	GroupStacks     = "Stacks"
	GroupImages     = "Images"
	GroupDeploy     = "Deploy"
)

// Groups lists the tool groups in display order.
var Groups = []string{GroupHosts, GroupContainers, GroupLogs, GroupStacks, GroupImages, GroupDeploy}

type prop = map[string]any

func str(desc string) prop     { return prop{"type": "string", "description": desc} }
func boolean(desc string) prop { return prop{"type": "boolean", "description": desc} }

func hostProp() prop      { return str("Host name or ID (see list_hosts).") }
func containerProp() prop { return str("Container name or ID.") }
func stackProp() prop     { return str("Stack (Compose project) name.") }
func confirmProp() prop {
	return boolean("Must be true to perform the action when the user requires confirmation")
}

// schema builds an object schema. Write tools get the optional confirm flag.
func schema(writes bool, props prop, required ...string) map[string]any {
	p := prop{}
	for k, v := range props {
		p[k] = v
	}
	if writes {
		p["confirm"] = confirmProp()
	}
	s := map[string]any{
		"type":       "object",
		"properties": p,
	}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func tool(group, name string, writes bool, desc string, props prop, required ...string) Tool {
	return Tool{Name: name, Group: group, Description: desc, Writes: writes, InputSchema: schema(writes, props, required...)}
}

// Catalog returns the full set of tools Dockhand can expose over MCP, in
// display order. Providers filter it per API key.
func Catalog() []Tool {
	return []Tool{
		// Hosts
		tool(GroupHosts, "list_hosts", false,
			"List the Docker hosts managed by Dockhand with their ID, name, address, status (online/offline), Docker version and container counts.",
			prop{}),
		tool(GroupHosts, "host_stats", false,
			"Get current resource usage for a host: CPU %, memory and disk usage, load average, uptime and running/stopped container counts.",
			prop{"host": hostProp()}, "host"),
		tool(GroupHosts, "reboot_host", true,
			"Reboot a host machine over SSH (sudo reboot). All containers on it go down until the host comes back.",
			prop{"host": hostProp()}, "host"),

		// Containers
		tool(GroupContainers, "list_containers", false,
			"List containers with name, image, state, status, ports, stack and CPU/memory usage. Omit host to list containers across all hosts.",
			prop{
				"host": str("Host name or ID. Omit to list containers on every host."),
				"all":  boolean("Include stopped containers (default false: running only)."),
			}),
		tool(GroupContainers, "inspect_container", false,
			"Show details of one container: image, command, state and health, restart policy, ports, environment (secrets masked), mounts, networks, labels and recent events.",
			prop{"host": hostProp(), "container": containerProp()}, "host", "container"),
		tool(GroupContainers, "start_container", true,
			"Start a stopped container.",
			prop{"host": hostProp(), "container": containerProp()}, "host", "container"),
		tool(GroupContainers, "stop_container", true,
			"Stop a running container (SIGTERM, then SIGKILL after the timeout).",
			prop{"host": hostProp(), "container": containerProp()}, "host", "container"),
		tool(GroupContainers, "restart_container", true,
			"Restart a container.",
			prop{"host": hostProp(), "container": containerProp()}, "host", "container"),
		tool(GroupContainers, "remove_container", true,
			"Remove a container. Its anonymous data is lost; named volumes are kept.",
			prop{
				"host":      hostProp(),
				"container": containerProp(),
				"force":     boolean("Kill and remove the container even if it is running (default false)."),
			}, "host", "container"),
		tool(GroupContainers, "update_container", true,
			"Pull the newest version of the container's image tag and recreate the container with the same configuration. For Compose-managed containers the service is recreated via its stack.",
			prop{"host": hostProp(), "container": containerProp()}, "host", "container"),

		// Logs
		tool(GroupLogs, "get_logs", false,
			"Fetch recent log lines (stdout and stderr, with timestamps) from a container.",
			prop{
				"host":      hostProp(),
				"container": containerProp(),
				"tail":      prop{"type": "integer", "minimum": 1, "maximum": 5000, "default": 200, "description": "Number of most recent lines to return (default 200)."},
				"since":     str(`Only return logs newer than this: a duration like "15m", "1h", "24h" or an RFC 3339 timestamp.`),
			}, "host", "container"),
		tool(GroupLogs, "search_logs", false,
			"Search a container's logs for lines containing a text (case-insensitive) and return the matching lines with timestamps.",
			prop{
				"host":      hostProp(),
				"container": containerProp(),
				"query":     str("Text to search for (case-insensitive substring)."),
				"since":     str(`Only search logs newer than this: a duration like "1h", "24h" or an RFC 3339 timestamp (default 24h).`),
			}, "host", "container", "query"),

		// Stacks
		tool(GroupStacks, "list_stacks", false,
			"List the Docker Compose stacks on a host with their status, number of services/containers, source (local or GitHub) and path.",
			prop{"host": hostProp()}, "host"),
		tool(GroupStacks, "get_compose", false,
			"Return the compose file (YAML) of a stack.",
			prop{"host": hostProp(), "stack": stackProp()}, "host", "stack"),
		tool(GroupStacks, "stack_action", true,
			"Run a lifecycle action on a stack: up (create/start), down (stop and remove containers), stop, restart, pull (pull images) or redeploy (pull and recreate; for GitHub stacks also fetches the latest commit).",
			prop{
				"host":   hostProp(),
				"stack":  stackProp(),
				"action": prop{"type": "string", "enum": []string{"up", "down", "stop", "restart", "pull", "redeploy"}, "description": "Action to perform."},
			}, "host", "stack", "action"),
		tool(GroupStacks, "pull_and_rebuild", true,
			"Update a stack that came from git: fetch the latest commit on its branch (for stacks deployed from GitHub, or a git clone on the host) and run docker compose up -d --build. Refuses when a host checkout has local changes unless force is set.",
			prop{
				"host":        hostProp(),
				"stack":       stackProp(),
				"force":       prop{"type": "boolean", "description": "Discard local changes in the host's checkout (git reset --hard to the remote branch)."},
				"pull_images": prop{"type": "boolean", "description": "Pull newer base images while building."},
				"no_cache":    prop{"type": "boolean", "description": "Rebuild every layer without the build cache."},
			}, "host", "stack"),
		tool(GroupStacks, "update_compose", true,
			"Replace a stack's compose file with new YAML content and apply it (docker compose up -d). The content is validated before it is written.",
			prop{
				"host":    hostProp(),
				"stack":   stackProp(),
				"content": str("The complete new compose file (YAML)."),
			}, "host", "stack", "content"),

		// Images
		tool(GroupImages, "list_images", false,
			"List the images on a host with repository, tag, ID, size, creation date and whether they are in use or dangling.",
			prop{"host": hostProp()}, "host"),
		tool(GroupImages, "pull_image", true,
			"Pull an image (e.g. \"nginx:1.27\" or \"ghcr.io/org/app:latest\") on one or more hosts.",
			prop{
				"image": str(`Image reference with tag, e.g. "nginx:1.27".`),
				"hosts": prop{"type": "array", "items": str("Host name or ID."), "minItems": 1, "description": "Hosts to pull the image on."},
			}, "image", "hosts"),
		tool(GroupImages, "prune_images", true,
			"Remove unused (dangling and unreferenced) images on a host to free disk space. Reports the space reclaimed.",
			prop{"host": hostProp()}, "host"),

		// Deploy
		tool(GroupDeploy, "deploy_from_github", true,
			"Deploy a Docker Compose project from a GitHub repository connected to Dockhand: fetches the branch, writes it to the host and runs docker compose up -d. Returns a job ID to follow progress.",
			prop{
				"repo":        str(`Repository as "owner/name".`),
				"branch":      str("Branch to deploy (default: the repository's default branch)."),
				"composeFile": str(`Path of the compose file in the repository (default: the first one found, e.g. "compose.yaml").`),
				"host":        hostProp(),
				"path":        str("Directory on the host to deploy into (default: the host's stacks directory plus the repository name)."),
			}, "repo", "host"),
		tool(GroupDeploy, "run_container", true,
			"Run a new standalone container from an image (like docker run -d).",
			prop{
				"host":  hostProp(),
				"image": str(`Image reference with tag, e.g. "nginx:1.27".`),
				"name":  str("Container name."),
				"ports": prop{"type": "array", "items": str(`Port mapping "hostPort:containerPort[/proto]", e.g. "8080:80".`), "description": "Published ports."},
				"env": prop{
					"type":                 "object",
					"additionalProperties": prop{"type": "string"},
					"description":          `Environment variables as {"KEY": "value"}.`,
				},
				"volumes": prop{"type": "array", "items": str(`Mount "source:target[:ro]" where source is a host path or volume name.`), "description": "Volumes and bind mounts."},
				"restart": prop{"type": "string", "enum": []string{"no", "always", "unless-stopped", "on-failure"}, "default": "unless-stopped", "description": "Restart policy (default unless-stopped)."},
			}, "host", "image", "name"),
	}
}
