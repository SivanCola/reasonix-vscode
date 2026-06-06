package acp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sync"

	"reasonix/internal/agent"
	"reasonix/internal/control"
	"reasonix/internal/event"
	"reasonix/internal/plugin"
)

// SessionParams is everything a Factory needs to assemble one ACP session's
// controller. Sink is owned by this package (an updateSink bound to the session
// id) and must be wired into the controller's event sink; the controller's
// interactive approval (see control.Controller.EnableInteractiveApproval) then
// routes "ask" decisions back through that sink as ApprovalRequest events, which
// the sink forwards to the client over session/request_permission.
//
// The Factory picks the model (ACP's session/new carries no model selection).
// Cwd roots the session's file tools and bash (built via builtin.Workspace).
// MCPServers are the stdio MCP servers the client asked the agent to connect for
// this session.
type SessionParams struct {
	Cwd        string
	MCPServers []plugin.Spec
	Sink       event.Sink
}

// Factory builds the per-session controller. The composition root (the cli's
// `reasonix acp` command) implements it by reusing setup()'s assembly: a
// Provider for Model, a tool Registry rooted at Cwd via builtin.Workspace, a
// per-session MCP host from MCPServers, the event Sink, all wired into a
// control.Controller. The returned controller owns its own cleanup (Close stops
// MCP subprocesses), so the service calls ctrl.Close() on teardown.
type Factory interface {
	NewSession(ctx context.Context, p SessionParams) (*control.Controller, error)
}

// AgentInfo identifies this agent to clients in the initialize reply.
type AgentInfo struct {
	Name    string
	Version string
}

// Serve runs an ACP agent on r/w (stdin/stdout in production) until the input
// ends or ctx is cancelled. It owns the JSON-RPC connection and the session
// registry; the Factory supplies the kernel wiring. This is the single entry
// point the `reasonix acp` command calls.
//
// stdout is the JSON-RPC channel: callers must keep all other output (logs,
// diagnostics) off w and on stderr, or the wire corrupts.
func Serve(ctx context.Context, r io.Reader, w io.Writer, factory Factory, info AgentInfo) error {
	conn := NewConn(r, w)
	svc := &service{
		conn:     conn,
		factory:  factory,
		info:     info,
		sessions: make(map[string]*acpSession),
	}
	conn.Handle("initialize", svc.initialize)
	conn.Handle("session/new", svc.sessionNew)
	conn.Handle("session/load", svc.sessionLoad)
	conn.Handle("session/prompt", svc.sessionPrompt)
	conn.Handle("session/status", svc.sessionStatus)
	conn.Handle("model/list", svc.modelList)
	conn.Handle("effort/set", svc.effortSet)
	conn.Handle("surface/list", svc.surfaceList)
	conn.HandleNotify("session/cancel", svc.sessionCancel)
	defer svc.closeAll()
	return conn.Serve(ctx)
}

// service holds the connection-wide ACP state: the factory, agent identity, and
// the live session registry.
type service struct {
	conn    *Conn
	factory Factory
	info    AgentInfo

	mu       sync.Mutex
	sessions map[string]*acpSession
}

type modelProvider interface {
	ListModels() (ModelListResult, error)
	SetEffort(EffortSetParams) (EffortSetResult, error)
}

// acpSession is one open session: its controller, the on-disk transcript path
// (empty when persistence is off), and the cancel func of the in-flight turn
// (nil when idle) so session/cancel can abort it.
type acpSession struct {
	id         string
	ctrl       *control.Controller
	transcript string

	mu     sync.Mutex
	cancel context.CancelFunc
}

func (s *acpSession) setCancel(c context.CancelFunc) {
	s.mu.Lock()
	s.cancel = c
	s.mu.Unlock()
}

func (s *acpSession) abort() {
	s.mu.Lock()
	c := s.cancel
	s.mu.Unlock()
	if c != nil {
		c()
	}
}

// initialize advertises the agent's capability set: sessions can be resumed via
// session/load (transcripts are keyed by session id under the session dir),
// prompts carry inline resource text (embeddedContext) but not image/audio, and
// MCP is stdio-only (no http/sse) — the latter three matching main.
func (s *service) initialize(_ context.Context, _ json.RawMessage) (any, error) {
	return InitializeResult{
		ProtocolVersion: ProtocolVersion,
		AgentCapabilities: AgentCapabilities{
			LoadSession: true,
			PromptCapabilities: PromptCapabilities{
				Image:           false,
				Audio:           false,
				EmbeddedContext: true,
			},
			MCPCapabilities: MCPCapabilities{HTTP: false, SSE: false},
		},
		AgentInfo:   Implementation{Name: s.info.Name, Version: s.info.Version},
		AuthMethods: []any{},
	}, nil
}

// sessionNew opens a session: it mints an id, builds the session's sink bound to
// that id, asks the Factory to assemble the controller, switches the controller
// to interactive approval (so tool gates surface as ApprovalRequest events the
// sink forwards), and registers it.
func (s *service) sessionNew(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SessionNewParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, &RPCError{Code: ErrInvalidParams, Message: "session/new: " + err.Error()}
		}
	}

	id, err := newSessionID()
	if err != nil {
		return nil, &RPCError{Code: ErrInternal, Message: "session/new: " + err.Error()}
	}

	sink := newUpdateSink(s.conn, id)
	ctrl, err := s.factory.NewSession(ctx, SessionParams{
		Cwd:        p.Cwd,
		MCPServers: mcpSpecs(p.MCPServers),
		Sink:       sink,
	})
	if err != nil {
		return nil, &RPCError{Code: ErrInternal, Message: "session/new: " + err.Error()}
	}
	ctrl.EnableInteractiveApproval()
	sink.bindApprove(ctrl.Approve)

	sess := &acpSession{id: id, ctrl: ctrl}
	// Pin a transcript file keyed by session id when the controller has a session
	// dir, so every turn auto-saves there, session/prompt can hand the path back,
	// and session/load can find it again by id across process restarts.
	if dir := ctrl.SessionDir(); dir != "" {
		sess.transcript = transcriptPath(dir, id)
		ctrl.SetSessionPath(sess.transcript)
	}

	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()

	return SessionNewResult{SessionID: id}, nil
}

// sessionLoad resumes a previously-saved session by id: it builds a controller
// (rooted at the requested cwd), seeds it from the on-disk transcript, replays
// the conversation to the client as session/update notifications, and registers
// it for subsequent prompts. A session already live in this process is replayed
// from memory without rebuilding.
func (s *service) sessionLoad(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SessionLoadParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/load: " + err.Error()}
	}
	if p.SessionID == "" {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/load: missing sessionId"}
	}

	if sess := s.session(p.SessionID); sess != nil {
		newUpdateSink(s.conn, p.SessionID).replay(sess.ctrl.History())
		return SessionLoadResult{}, nil
	}

	sink := newUpdateSink(s.conn, p.SessionID)
	ctrl, err := s.factory.NewSession(ctx, SessionParams{
		Cwd:        p.Cwd,
		MCPServers: mcpSpecs(p.MCPServers),
		Sink:       sink,
	})
	if err != nil {
		return nil, &RPCError{Code: ErrInternal, Message: "session/load: " + err.Error()}
	}
	ctrl.EnableInteractiveApproval()
	sink.bindApprove(ctrl.Approve)

	dir := ctrl.SessionDir()
	if dir == "" {
		ctrl.Close()
		return nil, &RPCError{Code: ErrInternal, Message: "session/load: persistence is disabled"}
	}
	path := transcriptPath(dir, p.SessionID)
	loaded, err := agent.LoadSession(path)
	if err != nil {
		ctrl.Close()
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/load: unknown session " + p.SessionID}
	}
	ctrl.Resume(loaded, path)

	sess := &acpSession{id: p.SessionID, ctrl: ctrl, transcript: path}
	s.mu.Lock()
	s.sessions[p.SessionID] = sess
	s.mu.Unlock()

	sink.replay(ctrl.History())
	return SessionLoadResult{}, nil
}

// transcriptPath is where a session's transcript lives — keyed by id so
// session/load can recover it. Distinct from the cli's timestamp-labelled
// chat/run session files (those are addressed by a picker, not by id).
func transcriptPath(dir, id string) string {
	return filepath.Join(dir, id+".jsonl")
}

// sessionPrompt runs one turn. It flattens the prompt blocks to text and runs the
// session's controller synchronously under a per-turn cancelable context (so
// session/cancel can stop it), then reports why the turn ended. The controller
// streams the turn's events to the session's sink as it runs.
func (s *service) sessionPrompt(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SessionPromptParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/prompt: " + err.Error()}
	}
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/prompt: unknown session " + p.SessionID}
	}
	text := FlattenPrompt(p.Prompt)
	if text == "" {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/prompt: empty prompt"}
	}

	runCtx, cancel := context.WithCancel(ctx)
	sess.setCancel(cancel)
	runErr := sess.ctrl.Run(runCtx, text)
	sess.setCancel(nil)
	cancel()

	// Persist after the turn (best-effort) so a crash loses at most this prompt;
	// save even on cancel/error since the partial conversation is still resumable.
	_ = sess.ctrl.Snapshot()

	stop := StopEndTurn
	if runErr != nil {
		if runCtx.Err() != nil {
			stop = StopCancelled
		} else {
			stop = StopError
		}
	}
	res := SessionPromptResult{StopReason: stop}
	if sess.transcript != "" {
		res.TranscriptPath = &sess.transcript
	}
	return res, nil
}

func (s *service) sessionStatus(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionStatusParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/status: " + err.Error()}
	}
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "session/status: unknown session " + p.SessionID}
	}
	used, window := sess.ctrl.ContextSnapshot()
	hit, miss := sess.ctrl.SessionCache()
	out := SessionStatusResult{
		Label:           sess.ctrl.Label(),
		Running:         sess.ctrl.Running(),
		Used:            used,
		Window:          window,
		CacheHit:        hit,
		CacheMiss:       miss,
		ConfiguredMCP:   sess.ctrl.ConfiguredMCPNames(),
		DisconnectedMCP: sess.ctrl.DisconnectedMCPNames(),
	}
	if h := sess.ctrl.Host(); h != nil {
		out.ConnectedMCP = h.ServerNames()
	}
	if u := sess.ctrl.LastUsage(); u != nil {
		out.LastUsage = &UsageUpdateData{
			PromptTokens:           u.PromptTokens,
			CompletionTokens:       u.CompletionTokens,
			TotalTokens:            u.TotalTokens,
			CacheHitTokens:         u.CacheHitTokens,
			CacheMissTokens:        u.CacheMissTokens,
			ReasoningTokens:        u.ReasoningTokens,
			SessionCacheHitTokens:  hit,
			SessionCacheMissTokens: miss,
		}
	}
	return out, nil
}

func (s *service) modelList(_ context.Context, _ json.RawMessage) (any, error) {
	mp, ok := s.factory.(modelProvider)
	if !ok {
		return nil, &RPCError{Code: ErrMethodNotFound, Message: "model/list unsupported"}
	}
	out, err := mp.ListModels()
	if err != nil {
		return nil, &RPCError{Code: ErrInternal, Message: "model/list: " + err.Error()}
	}
	return out, nil
}

func (s *service) effortSet(_ context.Context, raw json.RawMessage) (any, error) {
	var p EffortSetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "effort/set: " + err.Error()}
	}
	mp, ok := s.factory.(modelProvider)
	if !ok {
		return nil, &RPCError{Code: ErrMethodNotFound, Message: "effort/set unsupported"}
	}
	out, err := mp.SetEffort(p)
	if err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "effort/set: " + err.Error()}
	}
	return out, nil
}

func (s *service) surfaceList(_ context.Context, raw json.RawMessage) (any, error) {
	var p SurfaceListParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "surface/list: " + err.Error()}
	}
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, &RPCError{Code: ErrInvalidParams, Message: "surface/list: unknown session " + p.SessionID}
	}
	return surfaceListFor(sess.ctrl), nil
}

// sessionCancel aborts a session's in-flight turn, if any. It is a notification:
// no reply, and an unknown session is silently ignored.
func (s *service) sessionCancel(_ context.Context, raw json.RawMessage) {
	var p SessionCancelParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return
	}
	if sess := s.session(p.SessionID); sess != nil {
		sess.abort()
	}
}

func (s *service) session(id string) *acpSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[id]
}

// closeAll tears down every open session (aborting any in-flight turn and
// stopping its MCP subprocesses) when the connection ends.
func (s *service) closeAll() {
	s.mu.Lock()
	sessions := s.sessions
	s.sessions = make(map[string]*acpSession)
	s.mu.Unlock()
	for _, sess := range sessions {
		sess.abort()
		sess.ctrl.Close()
	}
}

// mcpSpecs converts ACP stdio MCP server declarations to plugin.Spec. ACP's
// session/new only carries stdio servers (the agent advertises http/sse off).
func mcpSpecs(in []MCPServerSpec) []plugin.Spec {
	if len(in) == 0 {
		return nil
	}
	out := make([]plugin.Spec, 0, len(in))
	for _, m := range in {
		out = append(out, plugin.Spec{
			Name:    m.Name,
			Type:    "stdio",
			Command: m.Command,
			Args:    m.Args,
			Env:     m.Env,
		})
	}
	return out
}

func surfaceListFor(ctrl *control.Controller) SurfaceListResult {
	var out SurfaceListResult
	for _, c := range ctrl.Commands() {
		out.Commands = append(out.Commands, SlashCommandInfo{
			Name:         c.Name,
			Description:  c.Description,
			ArgumentHint: c.ArgHint,
			Source:       c.Source,
		})
	}
	for _, sk := range ctrl.Skills() {
		out.Skills = append(out.Skills, SkillInfo{
			Name:        sk.Name,
			Scope:       string(sk.Scope),
			Subagent:    sk.RunAs == "subagent",
			Description: sk.Description,
		})
	}
	for _, sk := range ctrl.DisabledSkills() {
		out.DisabledSkills = append(out.DisabledSkills, SkillInfo{
			Name:        sk.Name,
			Scope:       string(sk.Scope),
			Subagent:    sk.RunAs == "subagent",
			Description: sk.Description,
		})
	}
	out.SlashCompletions = append(out.SlashCompletions,
		SlashCompletionInfo{Label: "/mcp", Insert: "/mcp ", Hint: "manage MCP servers", Descend: true},
		SlashCompletionInfo{Label: "/model", Insert: "/model ", Hint: "switch model", Descend: true},
		SlashCompletionInfo{Label: "/effort", Insert: "/effort ", Hint: "set reasoning effort", Descend: true},
		SlashCompletionInfo{Label: "/skills", Insert: "/skills ", Hint: "manage skills", Descend: true},
		SlashCompletionInfo{Label: "/compact", Insert: "/compact", Hint: "compact context"},
		SlashCompletionInfo{Label: "/new", Insert: "/new", Hint: "new session"},
	)
	for _, c := range out.Commands {
		out.SlashCompletions = append(out.SlashCompletions, SlashCompletionInfo{Label: "/" + c.Name, Insert: "/" + c.Name + " ", Hint: c.Description})
	}
	for _, sk := range out.Skills {
		out.SlashCompletions = append(out.SlashCompletions, SlashCompletionInfo{Label: "/" + sk.Name, Insert: "/" + sk.Name + " ", Hint: sk.Description})
	}
	if h := ctrl.Host(); h != nil {
		for _, s := range h.Servers() {
			info := MCPServerInfo{
				Name:      s.Name,
				Transport: s.Transport,
				Tools:     s.Tools,
				Prompts:   s.Prompts,
				Resources: s.Resources,
				Status:    "connected",
			}
			for _, t := range s.ToolList {
				info.ToolList = append(info.ToolList, MCPToolInfo{Name: t.Name, Description: t.Description})
			}
			out.MCPServers = append(out.MCPServers, info)
		}
		for _, f := range h.Failures() {
			out.MCPServers = append(out.MCPServers, MCPServerInfo{Name: f.Name, Transport: f.Transport, Status: "failed", Error: f.Error})
		}
		for _, p := range h.Prompts() {
			info := MCPPromptInfo{Name: p.Name, Server: p.Server, Description: p.Description}
			for _, a := range p.Args {
				info.Args = append(info.Args, a.Name)
			}
			out.MCPPrompts = append(out.MCPPrompts, info)
			out.SlashCompletions = append(out.SlashCompletions, SlashCompletionInfo{Label: "/" + p.Name, Insert: "/" + p.Name + " ", Hint: p.Description})
		}
		for _, r := range h.Resources() {
			out.MCPResources = append(out.MCPResources, MCPResourceInfo{
				URI:         r.URI,
				Server:      r.Server,
				Name:        r.Name,
				MimeType:    r.MimeType,
				Description: r.Description,
			})
		}
	}
	return out
}

// newSessionID returns a random RFC 4122 v4 UUID string used to address a session.
func newSessionID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
