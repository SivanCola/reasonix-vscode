package acp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/permission"
	"reasonix/internal/plugin"
)

// SessionParams is everything a Factory needs to assemble one ACP session's
// agent. Sink and Approver are owned by this package (an updateSink and an
// rpcApprover bound to the session id); the Factory wires them into the agent's
// event sink and into permission.NewGate(policy, approver) respectively. Model is
// empty when the client did not request one — the Factory picks its default.
//
// Cwd roots the session's file tools and bash. MCPServers are the stdio MCP
// servers the client asked the agent to connect for this session.
type SessionParams struct {
	Model      string
	Cwd        string
	MCPServers []plugin.Spec
	Sink       event.Sink
	Approver   permission.Approver
}

// Factory builds the per-session agent runner. The composition root (the cli's
// `reasonix acp` command, wired once the v2 refactor lands) implements it by
// reusing the extracted session-assembly logic: a Provider, a tool Registry
// rooted at Cwd, a per-session MCP host from MCPServers, an interactive Gate
// backed by the Approver, and the event Sink. The returned cleanup releases
// per-session resources (MCP subprocesses) and is called on teardown.
type Factory interface {
	NewSession(ctx context.Context, p SessionParams) (runner agent.Runner, cleanup func(), err error)
}

// AgentInfo identifies this agent to clients in the initialize reply.
type AgentInfo struct {
	Name    string
	Version string
}

// Serve runs an ACP agent on r/w (stdin/stdout in production) until the input
// ends or ctx is cancelled. It owns the JSON-RPC connection and the session
// registry; the Factory supplies the kernel wiring. This is the single entry
// point the `reasonix acp` command will call.
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
	conn.Handle("session/prompt", svc.sessionPrompt)
	conn.HandleNotify("session/cancel", svc.sessionCancel)
	defer svc.closeAll()
	return conn.Serve(ctx)
}

// closeAll tears down every open session's per-session resources (MCP
// subprocesses) when the connection ends.
func (s *service) closeAll() {
	s.mu.Lock()
	sessions := s.sessions
	s.sessions = make(map[string]*acpSession)
	s.mu.Unlock()
	for _, sess := range sessions {
		sess.abort()
		if sess.cleanup != nil {
			sess.cleanup()
		}
	}
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

// acpSession is one open session: its runner plus the cancel func of the
// in-flight turn (nil when idle) so session/cancel can abort it.
type acpSession struct {
	id      string
	runner  agent.Runner
	cleanup func()

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

// initialize advertises the agent's fixed capability set. The flags match main
// exactly: no loadSession, embedded resource text but no image/audio prompts,
// and stdio-only MCP (no http/sse).
func (s *service) initialize(_ context.Context, _ json.RawMessage) (any, error) {
	return InitializeResult{
		ProtocolVersion: ProtocolVersion,
		AgentCapabilities: AgentCapabilities{
			LoadSession: false,
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

// sessionNew opens a session: it mints an id, builds the session's sink and
// approver bound to that id, asks the Factory to assemble the agent, and
// registers it.
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

	params := SessionParams{
		Cwd:        p.Cwd,
		MCPServers: mcpSpecs(p.MCPServers),
		Sink:       newUpdateSink(s.conn, id),
		Approver:   newRPCApprover(s.conn, id),
	}
	runner, cleanup, err := s.factory.NewSession(ctx, params)
	if err != nil {
		return nil, &RPCError{Code: ErrInternal, Message: "session/new: " + err.Error()}
	}

	s.mu.Lock()
	s.sessions[id] = &acpSession{id: id, runner: runner, cleanup: cleanup}
	s.mu.Unlock()

	return SessionNewResult{SessionID: id}, nil
}

// sessionPrompt runs one turn. It flattens the prompt blocks to text, runs the
// session's agent under a per-turn cancelable context (so session/cancel can stop
// it), and reports why the turn ended.
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
	runErr := sess.runner.Run(runCtx, text)
	sess.setCancel(nil)
	cancel()

	stop := StopEndTurn
	if runErr != nil {
		if runCtx.Err() != nil {
			stop = StopCancelled
		} else {
			stop = StopError
		}
	}
	return SessionPromptResult{StopReason: stop}, nil
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
