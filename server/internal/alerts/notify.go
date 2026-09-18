package alerts

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"

	"dockhand/internal/model"
)

// Message is what gets sent to a channel.
type Message struct {
	Severity string    `json:"severity"`
	Kind     string    `json:"kind"`
	Title    string    `json:"title"`
	Text     string    `json:"text"`
	Host     string    `json:"host"`
	URL      string    `json:"url"`
	At       time.Time `json:"at"`
}

// Channel is a notification channel with its raw (unmasked) config.
type Channel struct {
	ID        string
	Type      string
	Name      string
	Config    map[string]string
	Enabled   bool
	CreatedAt time.Time
}

var channelTypes = map[string][]string{
	"email":   {"host", "port", "username", "password", "from", "to"},
	"slack":   {"url"},
	"webhook": {"url"},
	"ntfy":    {"url", "topic", "token"},
}

// secretKeys are masked in API responses.
var secretKeys = map[string]bool{"password": true, "token": true}

func isSecret(typ, key string) bool {
	if secretKeys[key] {
		return true
	}
	// Incoming-webhook URLs embed their credential.
	return key == "url" && (typ == "slack" || typ == "webhook")
}

const maskPrefix = "••••"

func mask(v string) string {
	if v == "" {
		return ""
	}
	if len(v) <= 4 {
		return maskPrefix
	}
	return maskPrefix + v[len(v)-4:]
}

// View converts to the API shape with secrets masked.
func (c Channel) View() model.NotificationChannel {
	cfg := map[string]string{}
	for k, v := range c.Config {
		if isSecret(c.Type, k) {
			v = mask(v)
		}
		cfg[k] = v
	}
	return model.NotificationChannel{ID: c.ID, Type: c.Type, Name: c.Name, Config: cfg, Enabled: c.Enabled, CreatedAt: c.CreatedAt}
}

func (e *Engine) decodeConfig(raw []byte) map[string]string {
	cfg := map[string]string{}
	_ = json.Unmarshal(raw, &cfg)
	for k, v := range cfg {
		if strings.HasPrefix(v, "enc:") {
			if d, err := e.box.Decrypt(strings.TrimPrefix(v, "enc:")); err == nil {
				cfg[k] = d
			} else {
				cfg[k] = ""
			}
		}
	}
	return cfg
}

func (e *Engine) encodeConfig(typ string, cfg map[string]string) ([]byte, error) {
	out := map[string]string{}
	for k, v := range cfg {
		if isSecret(typ, k) && v != "" {
			enc, err := e.box.Encrypt(v)
			if err != nil {
				return nil, err
			}
			v = "enc:" + enc
		}
		out[k] = v
	}
	return json.Marshal(out)
}

func (e *Engine) scanChannels(ctx context.Context, where string, args ...any) ([]Channel, error) {
	rows, err := e.db.Query(ctx, `SELECT id::text, type, name, config, enabled, created_at FROM notification_channels `+where+` ORDER BY created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		var c Channel
		var raw []byte
		if err := rows.Scan(&c.ID, &c.Type, &c.Name, &raw, &c.Enabled, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.Config = e.decodeConfig(raw)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (e *Engine) enabledChannels(ctx context.Context) ([]Channel, error) {
	return e.scanChannels(ctx, `WHERE enabled`)
}

// Channels lists all channels.
func (e *Engine) Channels(ctx context.Context) ([]Channel, error) { return e.scanChannels(ctx, ``) }

// GetChannel loads one channel.
func (e *Engine) GetChannel(ctx context.Context, id string) (Channel, error) {
	cs, err := e.scanChannels(ctx, `WHERE id::text = $1`, id)
	if err != nil {
		return Channel{}, err
	}
	if len(cs) == 0 {
		return Channel{}, errors.New("channel not found")
	}
	return cs[0], nil
}

// ChannelInput is the create/patch body.
type ChannelInput struct {
	Type    *string           `json:"type"`
	Name    *string           `json:"name"`
	Config  map[string]string `json:"config"`
	Enabled *bool             `json:"enabled"`
}

func validateChannel(c *Channel) error {
	keys, ok := channelTypes[c.Type]
	if !ok {
		return errors.New("type must be email, slack, ntfy or webhook")
	}
	if strings.TrimSpace(c.Name) == "" {
		c.Name = c.Type
	}
	clean := map[string]string{}
	for _, k := range keys {
		clean[k] = strings.TrimSpace(c.Config[k])
	}
	c.Config = clean
	switch c.Type {
	case "email":
		if clean["host"] == "" || clean["to"] == "" || clean["from"] == "" {
			return errors.New("email needs host, from and to")
		}
		if clean["port"] == "" {
			clean["port"] = "587"
		}
	case "ntfy":
		if clean["topic"] == "" {
			return errors.New("ntfy needs a topic")
		}
		if clean["url"] == "" {
			clean["url"] = "https://ntfy.sh"
		}
	default:
		if !strings.HasPrefix(clean["url"], "http://") && !strings.HasPrefix(clean["url"], "https://") {
			return errors.New("url must start with http:// or https://")
		}
	}
	return nil
}

// CreateChannel inserts a channel.
func (e *Engine) CreateChannel(ctx context.Context, in ChannelInput) (Channel, error) {
	c := Channel{Enabled: true, Config: in.Config}
	if in.Type != nil {
		c.Type = *in.Type
	}
	if in.Name != nil {
		c.Name = *in.Name
	}
	if in.Enabled != nil {
		c.Enabled = *in.Enabled
	}
	if err := validateChannel(&c); err != nil {
		return c, err
	}
	raw, err := e.encodeConfig(c.Type, c.Config)
	if err != nil {
		return c, err
	}
	err = e.db.QueryRow(ctx, `INSERT INTO notification_channels (type, name, config, enabled) VALUES ($1, $2, $3, $4)
		RETURNING id::text, created_at`, c.Type, c.Name, raw, c.Enabled).Scan(&c.ID, &c.CreatedAt)
	return c, err
}

// UpdateChannel applies a partial update. Masked secret values keep the stored value.
func (e *Engine) UpdateChannel(ctx context.Context, id string, in ChannelInput) (Channel, error) {
	c, err := e.GetChannel(ctx, id)
	if err != nil {
		return c, err
	}
	if in.Type != nil && *in.Type != c.Type {
		c.Type = *in.Type
	}
	if in.Name != nil {
		c.Name = *in.Name
	}
	if in.Enabled != nil {
		c.Enabled = *in.Enabled
	}
	for k, v := range in.Config {
		if strings.HasPrefix(v, maskPrefix) {
			continue
		}
		c.Config[k] = v
	}
	if err := validateChannel(&c); err != nil {
		return c, err
	}
	raw, err := e.encodeConfig(c.Type, c.Config)
	if err != nil {
		return c, err
	}
	_, err = e.db.Exec(ctx, `UPDATE notification_channels SET type=$2, name=$3, config=$4, enabled=$5 WHERE id::text=$1`,
		id, c.Type, c.Name, raw, c.Enabled)
	return c, err
}

// DeleteChannel removes a channel.
func (e *Engine) DeleteChannel(ctx context.Context, id string) error {
	_, err := e.db.Exec(ctx, `DELETE FROM notification_channels WHERE id::text = $1`, id)
	return err
}

// TestChannel sends a test message.
func (e *Engine) TestChannel(ctx context.Context, id string) error {
	c, err := e.GetChannel(ctx, id)
	if err != nil {
		return err
	}
	return Send(ctx, c, Message{Severity: "info", Kind: "test", Title: "Dockhand test notification",
		Text: "If you can read this, the " + c.Type + " channel \"" + c.Name + "\" works.", URL: e.absURL("/alerts"), At: time.Now()})
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

// Send delivers a message to one channel.
func Send(ctx context.Context, c Channel, m Message) error {
	emoji := map[string]string{"crit": "🔴", "warn": "🟠", "info": "🔵", "ok": "🟢"}[m.Severity]
	head := strings.TrimSpace(emoji + " " + m.Title)
	body := m.Text
	if m.Host != "" {
		body = strings.TrimSpace(body + "\nHost: " + m.Host)
	}
	if m.URL != "" {
		body = strings.TrimSpace(body + "\n" + m.URL)
	}
	switch c.Type {
	case "slack":
		return postJSON(ctx, c.Config["url"], map[string]any{"text": "*" + head + "*\n" + body}, nil)
	case "webhook":
		return postJSON(ctx, c.Config["url"], m, nil)
	case "ntfy":
		u := strings.TrimRight(c.Config["url"], "/") + "/" + c.Config["topic"]
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Title", m.Title)
		req.Header.Set("Priority", map[string]string{"crit": "urgent", "warn": "high", "ok": "default", "info": "default"}[m.Severity])
		req.Header.Set("Tags", map[string]string{"crit": "rotating_light", "warn": "warning", "ok": "white_check_mark", "info": "information_source"}[m.Severity])
		if m.URL != "" {
			req.Header.Set("Click", m.URL)
		}
		if t := c.Config["token"]; t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
		return do(req)
	case "email":
		return sendMail(ctx, c.Config, "[Dockhand] "+m.Title, body)
	}
	return fmt.Errorf("unknown channel type %q", c.Type)
}

func postJSON(ctx context.Context, url string, v any, hdr map[string]string) error {
	b, _ := json.Marshal(v)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Dockhand")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return do(req)
}

func do(req *http.Request) error {
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func sendMail(ctx context.Context, cfg map[string]string, subject, body string) error {
	host, port := cfg["host"], cfg["port"]
	if port == "" {
		port = "587"
	}
	addr := net.JoinHostPort(host, port)
	deadline := time.Now().Add(20 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	tlsCfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if port == "465" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if port != "465" {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsCfg); err != nil {
				return fmt.Errorf("STARTTLS: %w", err)
			}
		}
	}
	if u := cfg["username"]; u != "" {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(smtp.PlainAuth("", u, cfg["password"], host)); err != nil {
				return fmt.Errorf("SMTP auth: %w", err)
			}
		}
	}
	from := cfg["from"]
	if err := c.Mail(extractAddr(from)); err != nil {
		return err
	}
	tos := strings.FieldsFunc(cfg["to"], func(r rune) bool { return r == ',' || r == ';' || r == ' ' })
	for _, to := range tos {
		if err := c.Rcpt(extractAddr(to)); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	msg := "From: " + from + "\r\nTo: " + strings.Join(tos, ", ") + "\r\nSubject: " + subject +
		"\r\nDate: " + time.Now().Format(time.RFC1123Z) + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
		strings.ReplaceAll(body, "\n", "\r\n") + "\r\n"
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func extractAddr(s string) string {
	if i := strings.LastIndex(s, "<"); i >= 0 {
		if j := strings.LastIndex(s, ">"); j > i {
			return s[i+1 : j]
		}
	}
	return strings.TrimSpace(s)
}
