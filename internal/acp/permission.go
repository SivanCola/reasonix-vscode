package acp

import (
	"context"
	"encoding/json"
	"strconv"
	"sync/atomic"
)

// rpcApprover bridges the v2 permission.Approver contract onto an ACP
// session/request_permission round-trip. It is the counterpart of main's
// gates.ts: the agent's interactive Gate calls Approve when a tool needs the
// user's say-so, and we forward that as a permission request to the host client,
// blocking on its reply.
//
// It implements permission.Approver structurally (same Approve signature), so the
// composition root wraps the session policy with permission.NewGate(policy,
// approver) without this package importing the permission package.
type rpcApprover struct {
	conn      notifier
	sessionID string
	seq       atomic.Int64
}

func newRPCApprover(conn notifier, sessionID string) *rpcApprover {
	return &rpcApprover{conn: conn, sessionID: sessionID}
}

// Approve asks the host to allow a pending call. It returns whether to allow it
// and whether to remember the choice (mapped from the allow_always option). A
// cancelled or rejected outcome denies the call; a context error (the turn was
// cancelled while waiting) aborts the turn. This matches permission.Approver.
func (a *rpcApprover) Approve(ctx context.Context, toolName, subject string, args json.RawMessage) (allow, remember bool, err error) {
	id := "gate-" + toolName + "-" + strconv.FormatInt(a.seq.Add(1), 10)
	title := toolName
	if subject != "" {
		title = toolName + " " + subject
	}

	params := PermissionRequestParams{
		SessionID: a.sessionID,
		ToolCall: PermissionToolCall{
			ToolCallID: id,
			Title:      title,
			Kind:       toolKindFor(toolName),
			Status:     "pending",
			RawInput:   rawJSON(string(args)),
		},
		Options: []PermissionOption{
			{OptionID: string(OptAllowOnce), Name: "Allow", Kind: OptAllowOnce},
			{OptionID: string(OptAllowAlways), Name: "Always allow", Kind: OptAllowAlways},
			{OptionID: string(OptRejectOnce), Name: "Reject", Kind: OptRejectOnce},
		},
	}

	raw, err := a.conn.Request(ctx, "session/request_permission", params)
	if err != nil {
		// A cancelled turn must abort (surface the ctx error); any other transport
		// failure is treated as a denial so the model gets a blocked result rather
		// than the turn dying.
		if ctx.Err() != nil {
			return false, false, ctx.Err()
		}
		return false, false, nil
	}

	var res PermissionRequestResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return false, false, nil
	}
	if res.Outcome.Outcome != "selected" {
		return false, false, nil // "cancelled"
	}
	switch PermissionOptionKind(res.Outcome.OptionID) {
	case OptAllowOnce:
		return true, false, nil
	case OptAllowAlways:
		return true, true, nil
	case OptRejectOnce, OptRejectAlways:
		return false, false, nil
	default:
		return true, false, nil // unknown but selected → allow once
	}
}
