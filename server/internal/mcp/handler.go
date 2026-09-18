// Package mcp implements a Model Context Protocol server over the Streamable
// HTTP transport (JSON responses only, no SSE) for Dockhand.
package mcp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// LatestProtocolVersion is the protocol version Dockhand prefers.
const LatestProtocolVersion = "2025-06-18"

// SupportedProtocolVersions are accepted in initialize and echoed back.
var SupportedProtocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

const maxBodyBytes = 1 << 20

// JSON-RPC error codes.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
)

// Tool describes an MCP tool.
type Tool struct {
	Name        string
	Group       string // "Hosts" | "Containers" | "Logs" | "Stacks" | "Images" | "Deploy"
	Description string
	Writes      bool
	InputSchema map[string]any
}

// CallContext carries the caller identity and arguments of a tools/call.
type CallContext struct {
	KeyID   string
	KeyName string
	Args    map[string]any
}

// Result is the outcome of a tool call. IsError marks a tool-level error that
// is reported to the model (not a protocol error).
type Result struct {
	Text    string
	IsError bool
}

// Provider supplies authentication, the tool list and tool execution.
type Provider interface {
	Authenticate(r *http.Request) (keyID, keyName string, ok bool)
	Tools(keyID string) []Tool
	Call(ctx context.Context, c CallContext, name string) (Result, error)
	Enabled() bool
}

const instructions = "Dockhand is a self-hosted manager for Docker hosts. Use these tools to inspect and operate " +
	"the hosts registered in Dockhand: list hosts and their resource usage, list/inspect/start/stop/restart/update " +
	"containers, read and search container logs, manage Docker Compose stacks (view and edit compose files, up/down/" +
	"pull/redeploy), manage images, and deploy Compose projects straight from GitHub repositories. Hosts and " +
	"containers may be referred to by name or ID. Call list_hosts first to discover host names. Write tools may " +
	"require the argument \"confirm\": true; without it they explain what would happen instead of acting — show " +
	"that to the user and only retry with confirm=true after they agree."

type handler struct {
	p          Provider
	serverName string
	version    string
}

// NewHandler returns the http.Handler for the MCP endpoint.
func NewHandler(p Provider, serverName, version string) http.Handler {
	return &handler{p: p, serverName: serverName, version: version}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

var nullID = json.RawMessage("null")

type session struct {
	keyID, keyName string
	sessionID      string // set when an initialize was handled
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.p.Enabled() {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost, http.MethodDelete:
	default:
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed; use POST"})
		return
	}
	keyID, keyName, ok := h.p.Authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="dockhand"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized: a valid Dockhand API key is required (Authorization: Bearer dh_…)"})
		return
	}
	if r.Method == http.MethodDelete {
		// Sessions are stateless; ending one is always successful.
		w.WriteHeader(http.StatusOK)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse(nullID, codeInvalidRequest, "request body exceeds 1 MB"))
			return
		}
		writeJSON(w, http.StatusBadRequest, errorResponse(nullID, codeParseError, "could not read request body"))
		return
	}
	body = bytes.TrimSpace(body)
	s := &session{keyID: keyID, keyName: keyName}

	if len(body) > 0 && body[0] == '[' {
		var msgs []json.RawMessage
		if err := json.Unmarshal(body, &msgs); err != nil {
			writeJSON(w, http.StatusOK, errorResponse(nullID, codeParseError, "parse error: "+err.Error()))
			return
		}
		if len(msgs) == 0 {
			writeJSON(w, http.StatusOK, errorResponse(nullID, codeInvalidRequest, "empty batch"))
			return
		}
		var out []*rpcResponse
		for _, m := range msgs {
			if resp := h.handleMessage(r.Context(), s, m); resp != nil {
				out = append(out, resp)
			}
		}
		h.setSessionHeader(w, s)
		if len(out) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	if !json.Valid(body) {
		writeJSON(w, http.StatusOK, errorResponse(nullID, codeParseError, "parse error: invalid JSON"))
		return
	}
	resp := h.handleMessage(r.Context(), s, body)
	h.setSessionHeader(w, s)
	if resp == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handler) setSessionHeader(w http.ResponseWriter, s *session) {
	if s.sessionID != "" {
		w.Header().Set("Mcp-Session-Id", s.sessionID)
	}
}

// handleMessage processes one JSON-RPC message; nil means no response
// (notifications and client responses).
func (h *handler) handleMessage(ctx context.Context, s *session, raw json.RawMessage) (resp *rpcResponse) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return errorResponse(nullID, codeInvalidRequest, "invalid request: expected a JSON object")
	}
	id, hasID := fields["id"]
	if hasID && !validID(id) {
		return errorResponse(nullID, codeInvalidRequest, "invalid request: id must be a string or number")
	}
	if _, isMethod := fields["method"]; !isMethod {
		if _, isResult := fields["result"]; isResult {
			return nil // a response from the client; nothing to do
		}
		if _, isErr := fields["error"]; isErr {
			return nil
		}
	}
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.JSONRPC != "2.0" || req.Method == "" {
		if !hasID {
			id = nullID
		}
		return errorResponse(id, codeInvalidRequest, "invalid request: expected jsonrpc \"2.0\" and a method")
	}
	if !hasID {
		// Notification (notifications/initialized, notifications/cancelled, …).
		return nil
	}

	defer func() {
		if rec := recover(); rec != nil {
			resp = errorResponse(id, codeInternalError, fmt.Sprintf("internal error: %v", rec))
		}
	}()

	result, rerr := h.dispatch(ctx, s, req.Method, req.Params)
	if rerr != nil {
		return &rpcResponse{JSONRPC: "2.0", ID: id, Error: rerr}
	}
	return &rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func validID(id json.RawMessage) bool {
	t := bytes.TrimSpace(id)
	if len(t) == 0 {
		return false
	}
	switch t[0] {
	case '"':
		return true
	case 'n': // null is tolerated
		return string(t) == "null"
	default:
		var n json.Number
		return json.Unmarshal(t, &n) == nil
	}
}

func (h *handler) dispatch(ctx context.Context, s *session, method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(params) > 0 {
			if err := json.Unmarshal(params, &p); err != nil {
				return nil, &rpcError{Code: codeInvalidParams, Message: "invalid params: " + err.Error()}
			}
		}
		version := LatestProtocolVersion
		for _, v := range SupportedProtocolVersions {
			if p.ProtocolVersion == v {
				version = v
			}
		}
		s.sessionID = newSessionID()
		return map[string]any{
			"protocolVersion": version,
			"capabilities": map[string]any{
				"tools": map[string]any{"listChanged": false},
			},
			"serverInfo": map[string]any{
				"name":    h.serverName,
				"version": h.version,
			},
			"instructions": instructions,
		}, nil

	case "ping":
		return map[string]any{}, nil

	case "tools/list":
		tools := h.p.Tools(s.keyID)
		list := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			schema := t.InputSchema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			list = append(list, map[string]any{
				"name":        t.Name,
				"title":       toolTitle(t.Name),
				"description": t.Description,
				"inputSchema": schema,
				"annotations": map[string]any{
					"title":           toolTitle(t.Name),
					"readOnlyHint":    !t.Writes,
					"destructiveHint": t.Writes,
				},
			})
		}
		return map[string]any{"tools": list}, nil

	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if len(params) == 0 {
			return nil, &rpcError{Code: codeInvalidParams, Message: "invalid params: missing tool name"}
		}
		dec := json.NewDecoder(bytes.NewReader(params))
		dec.UseNumber()
		if err := dec.Decode(&p); err != nil {
			return nil, &rpcError{Code: codeInvalidParams, Message: "invalid params: " + err.Error()}
		}
		if p.Name == "" {
			return nil, &rpcError{Code: codeInvalidParams, Message: "invalid params: missing tool name"}
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		normalizeNumbers(p.Arguments)
		found := false
		for _, t := range h.p.Tools(s.keyID) {
			if t.Name == p.Name {
				found = true
				break
			}
		}
		if !found {
			return toolResult(Result{Text: fmt.Sprintf("Unknown tool %q, or it is not enabled for this API key.", p.Name), IsError: true}), nil
		}
		res, err := h.p.Call(ctx, CallContext{KeyID: s.keyID, KeyName: s.keyName, Args: p.Arguments}, p.Name)
		if err != nil {
			return nil, &rpcError{Code: codeInternalError, Message: err.Error()}
		}
		return toolResult(res), nil
	}
	return nil, &rpcError{Code: codeMethodNotFound, Message: "method not found: " + method}
}

// normalizeNumbers turns json.Number values into int64 when integral, else
// float64, so providers see plain Go numbers.
func normalizeNumbers(m map[string]any) {
	for k, v := range m {
		m[k] = normalizeValue(v)
	}
}

func normalizeValue(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		f, _ := x.Float64()
		return f
	case map[string]any:
		normalizeNumbers(x)
		return x
	case []any:
		for i := range x {
			x[i] = normalizeValue(x[i])
		}
		return x
	}
	return v
}

func toolResult(r Result) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": r.Text}},
		"isError": r.IsError,
	}
}

func toolTitle(name string) string {
	s := strings.ReplaceAll(name, "_", " ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func errorResponse(id json.RawMessage, code int, msg string) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
