package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// SelectBackend resolves a supported single-workspace operation. Operations
// which need aggregation, creation, or additional routing are rejected rather
// than accidentally delivered to the wrong daemon.
func (p *Provisioner) SelectBackend(ctx context.Context, frame []byte) (string, error) {
	var envelope struct {
		Type    string                     `json:"type"`
		Message map[string]json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil || envelope.Type != "session" || envelope.Message == nil {
		return "", errors.New("invalid Paseo session frame")
	}
	var operation string
	if json.Unmarshal(envelope.Message["type"], &operation) != nil {
		return "", errors.New("missing operation type")
	}
	var fields []string
	switch operation {
	case "agent.create.request", "create_agent_request":
		// An optional agentId is a new identity and cannot yet be resolved.
		fields = []string{"workspaceId"}
	case "send_agent_message", "send_agent_message_request", "cancel_agent_request", "fetch_agent_request", "fetch_agent_history_request", "fetch_agent_timeline_request", "agent.timeline.search.request", "agent.timeline.list_prompts.request", "agent.timeline.set_subscription.request", "agent.timeline.append.request", "agent_permission_response":
		fields = []string{"agentId"}
	case "workspace.script.list.request", "workspace.script.start.request", "workspace.script.stop.request", "start_workspace_script_request":
		fields = []string{"workspaceId"}
	case "create_terminal_request":
		fields = []string{"workspaceId", "agentId"}
	case "terminal.rename.request", "subscribe_terminal_request", "unsubscribe_terminal_request", "terminal_input", "kill_terminal_request", "capture_terminal_request":
		fields = []string{"terminalId"}
	default:
		return "", fmt.Errorf("gateway operation %q is not supported by single-workspace routing", operation)
	}
	kinds := map[string]string{"workspaceId": "workspace", "agentId": "agent", "terminalId": "terminal"}
	endpoint := ""
	for _, field := range fields {
		raw, ok := envelope.Message[field]
		if !ok || string(raw) == "null" {
			continue
		}
		var id string
		if json.Unmarshal(raw, &id) != nil || !validRouteID(id) {
			return "", fmt.Errorf("invalid %s", field)
		}
		target, err := p.Resolve(ctx, kinds[field], id)
		if err != nil {
			return "", fmt.Errorf("resolve %s: %w", field, err)
		}
		if endpoint != "" && target != endpoint {
			return "", errors.New("request targets multiple workspaces")
		}
		endpoint = target
	}
	if endpoint == "" {
		return "", errors.New("request has no routable workspace identity")
	}
	return endpoint, nil
}
