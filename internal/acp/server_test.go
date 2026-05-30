package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/permission"
)

// --- fakes: a Factory/Runner pair driven by an injected behavior ---

type fakeRunner struct {
	sink     event.Sink
	approver permission.Approver
	behavior func(ctx context.Context, r *fakeRunner, input string) error
}

func (r *fakeRunner) Run(ctx context.Context, input string) error {
	return r.behavior(ctx, r, input)
}

type fakeFactory struct {
	behavior func(ctx context.Context, r *fakeRunner, input string) error
	mu       sync.Mutex
	params   []SessionParams
}

func (f *fakeFactory) NewSession(_ context.Context, p SessionParams) (agent.Runner, func(), error) {
	f.mu.Lock()
	f.params = append(f.params, p)
	f.mu.Unlock()
	return &fakeRunner{sink: p.Sink, approver: p.Approver, behavior: f.behavior}, func() {}, nil
}

// --- a minimal JSON-RPC client over the wire, for integration tests ---

type frame struct {
	ID     *json.RawMessage `json:"id"`
	Method string           `json:"method"`
	Params json.RawMessage  `json:"params"`
	Result json.RawMessage  `json:"result"`
	Error  *rpcError        `json:"error"`
}

type rpcClient struct {
	enc *json.Encoder
	wmu sync.Mutex

	mu     sync.Mutex
	nextID int64
	waits  map[int64]chan frame

	notifs chan frame
	reqs   chan frame
}

func newRPCClient(in io.Writer, out io.Reader) *rpcClient {
	c := &rpcClient{
		enc:    json.NewEncoder(in),
		waits:  make(map[int64]chan frame),
		notifs: make(chan frame, 64),
		reqs:   make(chan frame, 16),
	}
	dec := json.NewDecoder(out)
	go func() {
		for {
			var f frame
			if err := dec.Decode(&f); err != nil {
				return
			}
			switch {
			case f.Method != "" && f.ID != nil:
				c.reqs <- f
			case f.Method != "" && f.ID == nil:
				c.notifs <- f
			case f.Method == "" && f.ID != nil:
				var id int64
				if json.Unmarshal(*f.ID, &id) != nil {
					continue
				}
				c.mu.Lock()
				ch := c.waits[id]
				delete(c.waits, id)
				c.mu.Unlock()
				if ch != nil {
					ch <- f
				}
			}
		}
	}()
	return c
}

func (c *rpcClient) send(v any) {
	c.wmu.Lock()
	_ = c.enc.Encode(v)
	c.wmu.Unlock()
}

func (c *rpcClient) callAsync(method string, params any) chan frame {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan frame, 1)
	c.waits[id] = ch
	c.mu.Unlock()
	c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return ch
}

func (c *rpcClient) call(t *testing.T, method string, params any) frame {
	t.Helper()
	select {
	case f := <-c.callAsync(method, params):
		return f
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: timed out", method)
		return frame{}
	}
}

func (c *rpcClient) notify(method string, params any) {
	c.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *rpcClient) reply(id *json.RawMessage, result any) {
	c.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func startServer(t *testing.T, factory Factory) (*rpcClient, func()) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan struct{})
	go func() {
		_ = Serve(context.Background(), inR, outW, factory, AgentInfo{Name: "reasonix-test", Version: "0"})
		close(done)
	}()
	client := newRPCClient(inW, outR)
	return client, func() {
		_ = inW.Close()
		<-done
		_ = outW.Close()
	}
}

// drainPrompt collects session/update notifications until the prompt's response
// arrives, then sweeps any notifications still buffered.
func drainPrompt(t *testing.T, c *rpcClient, promptCh chan frame) ([]frame, frame) {
	t.Helper()
	var notifs []frame
	var resp frame
	for {
		select {
		case f := <-c.notifs:
			notifs = append(notifs, f)
		case resp = <-promptCh:
			for {
				select {
				case f := <-c.notifs:
					notifs = append(notifs, f)
				default:
					return notifs, resp
				}
			}
		case <-time.After(2 * time.Second):
			t.Fatal("session/prompt: timed out")
		}
	}
}

func updateKind(t *testing.T, f frame) string {
	t.Helper()
	var p struct {
		Update struct {
			SessionUpdate string `json:"sessionUpdate"`
		} `json:"update"`
	}
	if err := json.Unmarshal(f.Params, &p); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	return p.Update.SessionUpdate
}

// --- tests ---

func TestServeLifecycle(t *testing.T) {
	factory := &fakeFactory{behavior: func(_ context.Context, r *fakeRunner, input string) error {
		r.sink.Emit(event.Event{Kind: event.Text, Text: "hi " + input})
		r.sink.Emit(event.Event{Kind: event.ToolDispatch, Tool: event.Tool{ID: "c1", Name: "ls", Args: `{}`}})
		r.sink.Emit(event.Event{Kind: event.ToolResult, Tool: event.Tool{ID: "c1", Name: "ls", Output: "file.go"}})
		return nil
	}}
	client, stop := startServer(t, factory)
	defer stop()

	initResp := client.call(t, "initialize", InitializeParams{ProtocolVersion: 1})
	var ir InitializeResult
	if err := json.Unmarshal(initResp.Result, &ir); err != nil {
		t.Fatalf("initialize result: %v", err)
	}
	if ir.ProtocolVersion != ProtocolVersion {
		t.Errorf("protocolVersion = %d, want %d", ir.ProtocolVersion, ProtocolVersion)
	}
	if !ir.AgentCapabilities.PromptCapabilities.EmbeddedContext {
		t.Errorf("embeddedContext should be advertised")
	}
	if ir.AgentCapabilities.PromptCapabilities.Image {
		t.Errorf("image must not be advertised")
	}

	newResp := client.call(t, "session/new", SessionNewParams{Cwd: "/tmp"})
	var nr SessionNewResult
	if err := json.Unmarshal(newResp.Result, &nr); err != nil || nr.SessionID == "" {
		t.Fatalf("session/new result: %v (%q)", err, nr.SessionID)
	}

	promptCh := client.callAsync("session/prompt", SessionPromptParams{
		SessionID: nr.SessionID,
		Prompt:    []ContentBlock{{Type: "text", Text: "there"}},
	})
	notifs, resp := drainPrompt(t, client, promptCh)

	kinds := map[string]bool{}
	for _, n := range notifs {
		kinds[updateKind(t, n)] = true
	}
	for _, want := range []string{"agent_message_chunk", "tool_call", "tool_call_update"} {
		if !kinds[want] {
			t.Errorf("missing %s update; saw %v", want, kinds)
		}
	}
	var pr SessionPromptResult
	if err := json.Unmarshal(resp.Result, &pr); err != nil {
		t.Fatalf("prompt result: %v", err)
	}
	if pr.StopReason != StopEndTurn {
		t.Errorf("stopReason = %q, want %q", pr.StopReason, StopEndTurn)
	}
}

func TestServePermissionRoundTrip(t *testing.T) {
	factory := &fakeFactory{behavior: func(ctx context.Context, r *fakeRunner, _ string) error {
		allow, remember, err := r.approver.Approve(ctx, "bash", "rm -rf /", json.RawMessage(`{"command":"rm -rf /"}`))
		if err != nil {
			return err
		}
		r.sink.Emit(event.Event{Kind: event.Text, Text: fmt.Sprintf("allow=%v remember=%v", allow, remember)})
		return nil
	}}
	client, stop := startServer(t, factory)
	defer stop()

	client.call(t, "initialize", InitializeParams{ProtocolVersion: 1})
	newResp := client.call(t, "session/new", SessionNewParams{})
	var nr SessionNewResult
	json.Unmarshal(newResp.Result, &nr)

	promptCh := client.callAsync("session/prompt", SessionPromptParams{
		SessionID: nr.SessionID,
		Prompt:    []ContentBlock{{Type: "text", Text: "go"}},
	})

	// The agent's Approve fires a session/request_permission request; answer it.
	select {
	case req := <-client.reqs:
		if req.Method != "session/request_permission" {
			t.Fatalf("unexpected request %q", req.Method)
		}
		var pr PermissionRequestParams
		if err := json.Unmarshal(req.Params, &pr); err != nil {
			t.Fatalf("permission params: %v", err)
		}
		if pr.ToolCall.Kind != "execute" {
			t.Errorf("permission kind = %q, want execute", pr.ToolCall.Kind)
		}
		client.reply(req.ID, PermissionRequestResult{
			Outcome: PermissionOutcome{Outcome: "selected", OptionID: string(OptAllowAlways)},
		})
	case <-time.After(2 * time.Second):
		t.Fatal("no permission request received")
	}

	notifs, resp := drainPrompt(t, client, promptCh)
	var pr SessionPromptResult
	json.Unmarshal(resp.Result, &pr)
	if pr.StopReason != StopEndTurn {
		t.Errorf("stopReason = %q, want end_turn", pr.StopReason)
	}
	var sawDecision bool
	for _, n := range notifs {
		var p struct {
			Update struct {
				Content struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"update"`
		}
		json.Unmarshal(n.Params, &p)
		if p.Update.Content.Text == "allow=true remember=true" {
			sawDecision = true
		}
	}
	if !sawDecision {
		t.Errorf("approver did not resolve to allow_always (allow=true remember=true)")
	}
}

func TestServeCancel(t *testing.T) {
	started := make(chan struct{})
	factory := &fakeFactory{behavior: func(ctx context.Context, _ *fakeRunner, _ string) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}}
	client, stop := startServer(t, factory)
	defer stop()

	client.call(t, "initialize", InitializeParams{ProtocolVersion: 1})
	newResp := client.call(t, "session/new", SessionNewParams{})
	var nr SessionNewResult
	json.Unmarshal(newResp.Result, &nr)

	promptCh := client.callAsync("session/prompt", SessionPromptParams{
		SessionID: nr.SessionID,
		Prompt:    []ContentBlock{{Type: "text", Text: "loop"}},
	})

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("prompt never started")
	}
	client.notify("session/cancel", SessionCancelParams{SessionID: nr.SessionID})

	select {
	case resp := <-promptCh:
		var pr SessionPromptResult
		json.Unmarshal(resp.Result, &pr)
		if pr.StopReason != StopCancelled {
			t.Errorf("stopReason = %q, want cancelled", pr.StopReason)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not end the prompt")
	}
}

func TestServeUnknownMethod(t *testing.T) {
	factory := &fakeFactory{behavior: func(context.Context, *fakeRunner, string) error { return nil }}
	client, stop := startServer(t, factory)
	defer stop()

	resp := client.call(t, "does/not/exist", nil)
	if resp.Error == nil {
		t.Fatal("expected an error response")
	}
	if resp.Error.Code != ErrMethodNotFound {
		t.Errorf("error code = %d, want %d", resp.Error.Code, ErrMethodNotFound)
	}
}
