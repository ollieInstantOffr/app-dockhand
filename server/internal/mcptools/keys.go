// Package mcptools implements Dockhand's MCP provider: API keys, tool
// filtering, confirmation gating, activity logging and the tools themselves.
package mcptools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/mcp"
	"dockhand/internal/model"
	"dockhand/internal/secret"
	"dockhand/internal/util"
)

const keyPrefix = "dh_live_"

// Key is an api_keys row.
type Key struct {
	model.ApiKey
}

func hashKey(k string) string {
	sum := sha256.Sum256([]byte(k))
	return hex.EncodeToString(sum[:])
}

const keyCols = `id::text, name, client, prefix, scope, groups, host_ids, expires_at, last_used_at, revoked_at IS NOT NULL, created_at`

func scanKey(row interface{ Scan(...any) error }) (Key, error) {
	var k Key
	var groups, hostIDs []byte
	a := &k.ApiKey
	err := row.Scan(&a.ID, &a.Name, &a.Client, &a.Prefix, &a.Scope, &groups, &hostIDs, &a.ExpiresAt, &a.LastUsedAt, &a.Revoked, &a.CreatedAt)
	if err != nil {
		return k, err
	}
	_ = json.Unmarshal(groups, &a.Groups)
	_ = json.Unmarshal(hostIDs, &a.HostIDs)
	a.Groups, a.HostIDs = util.NZ(a.Groups), util.NZ(a.HostIDs)
	return k, nil
}

// Keys lists API keys (newest first).
func (p *Provider) Keys(ctx context.Context) ([]model.ApiKey, error) {
	rows, err := p.db.Query(ctx, `SELECT `+keyCols+` FROM api_keys ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ApiKey{}
	for rows.Next() {
		k, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k.ApiKey)
	}
	return out, rows.Err()
}

func (p *Provider) key(ctx context.Context, id string) (Key, error) {
	k, err := scanKey(p.db.QueryRow(ctx, `SELECT `+keyCols+` FROM api_keys WHERE id::text = $1`, id))
	if db.IsNoRows(err) {
		return k, errors.New("API key not found")
	}
	return k, err
}

// CreateKey issues a new key and returns it with the full secret (shown once).
func (p *Provider) CreateKey(ctx context.Context, in model.ApiKeyInput) (model.ApiKeyWithSecret, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return model.ApiKeyWithSecret{}, &dockerops.BadRequest{Msg: "name is required"}
	}
	switch in.Client {
	case "claude", "cursor", "other":
	case "":
		in.Client = "other"
	default:
		return model.ApiKeyWithSecret{}, &dockerops.BadRequest{Msg: "client must be claude, cursor or other"}
	}
	switch in.Scope {
	case "read", "full", "custom":
	case "":
		in.Scope = "read"
	default:
		return model.ApiKeyWithSecret{}, &dockerops.BadRequest{Msg: "scope must be read, full or custom"}
	}
	valid := map[string]bool{}
	for _, g := range mcp.Groups {
		valid[g] = true
	}
	for _, g := range in.Groups {
		if !valid[g] {
			return model.ApiKeyWithSecret{}, &dockerops.BadRequest{Msg: "unknown tool group " + g}
		}
	}
	if in.Scope == "custom" && len(in.Groups) == 0 {
		return model.ApiKeyWithSecret{}, &dockerops.BadRequest{Msg: "choose at least one tool group for a custom key"}
	}
	var exp *time.Time
	if in.ExpiresDays > 0 {
		t := time.Now().Add(time.Duration(in.ExpiresDays) * 24 * time.Hour)
		exp = &t
	}
	full := keyPrefix + secret.RandomBase62(32)
	k, err := scanKey(p.db.QueryRow(ctx, `INSERT INTO api_keys (name, client, prefix, hash, scope, groups, host_ids, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+keyCols,
		in.Name, in.Client, full[:12], hashKey(full), in.Scope, db.JSON(util.NZ(in.Groups)), db.JSON(util.NZ(in.HostIDs)), exp))
	if err != nil {
		return model.ApiKeyWithSecret{}, err
	}
	return model.ApiKeyWithSecret{ApiKey: k.ApiKey, Key: full}, nil
}

// RevokeKey revokes a key.
func (p *Provider) RevokeKey(ctx context.Context, id string) error {
	tag, err := p.db.Exec(ctx, `UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("API key not found")
	}
	return nil
}

// Authenticate implements mcp.Provider.
func (p *Provider) Authenticate(r *http.Request) (string, string, bool) {
	h := r.Header.Get("Authorization")
	if len(h) < 8 || !strings.EqualFold(h[:7], "bearer ") {
		return "", "", false
	}
	tok := strings.TrimSpace(h[7:])
	if !strings.HasPrefix(tok, keyPrefix) {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var id, name string
	var last *time.Time
	err := p.db.QueryRow(ctx, `SELECT id::text, name, last_used_at FROM api_keys WHERE hash = $1 AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > now())`, hashKey(tok)).Scan(&id, &name, &last)
	if err != nil {
		return "", "", false
	}
	if last == nil || time.Since(*last) > 30*time.Second {
		_, _ = p.db.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE id::text = $1`, id)
	}
	return id, name, true
}

// Activity returns recent MCP calls.
func (p *Provider) Activity(ctx context.Context, limit int) ([]model.McpActivity, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := p.db.Query(ctx, `SELECT id, client, tool, detail, ok, at FROM mcp_activity ORDER BY at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.McpActivity{}
	for rows.Next() {
		var a model.McpActivity
		if err := rows.Scan(&a.ID, &a.Client, &a.Tool, &a.Detail, &a.OK, &a.At); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// PublishedPort is the MCP port published by docker-compose (set from config at startup).
var PublishedPort int

// Status returns the MCP status for the settings page.
func (p *Provider) Status(ctx context.Context) (model.McpStatus, error) {
	cfg := p.settings.Get()
	st := model.McpStatus{URL: endpointURL(cfg.General.PublicURL, cfg.MCP.Port), Port: cfg.MCP.Port, PublishedPort: PublishedPort, Tools: []model.McpTool{}}
	if cfg.MCP.Enabled && cfg.MCP.Port > 0 {
		if _, e := p.listenState(); e != "" {
			st.ListenError = e
		}
	}
	_ = p.db.QueryRow(ctx, `SELECT count(*) FROM mcp_activity WHERE at >= date_trunc('day', now())`).Scan(&st.CallsToday)
	for _, t := range mcp.Catalog() {
		st.Tools = append(st.Tools, model.McpTool{Name: t.Name, Group: t.Group, Desc: t.Description, Writes: t.Writes})
	}
	return st, nil
}

func (p *Provider) logActivity(keyID, client, tool, detail string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var kid any
	if keyID != "" {
		kid = keyID
	}
	_, _ = p.db.Exec(ctx, `INSERT INTO mcp_activity (api_key_id, client, tool, detail, ok) VALUES ($1, $2, $3, $4, $5)`,
		kid, client, tool, util.Truncate(detail, 400), ok)
}

// Prune deletes activity older than 90 days.
func (p *Provider) Prune(ctx context.Context) error {
	_, err := p.db.Exec(ctx, `DELETE FROM mcp_activity WHERE at < now() - interval '90 days'`)
	return err
}
