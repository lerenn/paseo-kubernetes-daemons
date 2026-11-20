package gateway

import "errors"

// These requirements match Paseo 0.16.2 for the operations currently handled
// by this gateway. Unknown operations are denied until explicitly reviewed.
var operationPermissions = map[string][]string{
	"workspace.create.request":                {"workspace.manage"},
	"project.list.request":                    {"workspace.read"},
	"fetch_workspaces_request":                {"workspace.read", "hub.execute"},
	"fetch_agents_request":                    {"workspace.read", "hub.execute"},
	"agent.create.request":                    {"workspace.write", "hub.execute"},
	"create_agent_request":                    {"workspace.write", "hub.execute"},
	"send_agent_message_request":              {"workspace.write", "hub.execute"},
	"cancel_agent_request":                    {"workspace.write", "hub.execute"},
	"fetch_agent_request":                     {"workspace.read", "hub.execute"},
	"fetch_agent_history_request":             {"workspace.read"},
	"fetch_agent_timeline_request":            {"workspace.read", "hub.execute"},
	"agent.timeline.search.request":           {"workspace.read"},
	"agent.timeline.list_prompts.request":     {"workspace.read"},
	"agent.timeline.set_subscription.request": {"workspace.read", "hub.execute"},
	"agent.timeline.append.request":           {"workspace.write"},
	"agent_permission_response":               {"workspace.write"},
	"workspace.script.list.request":           {"workspace.read"},
	"workspace.script.start.request":          {"workspace.write"},
	"workspace.script.stop.request":           {"workspace.write"},
	"start_workspace_script_request":          {"workspace.write"},
	"checkout_status_request":                 {"workspace.read"},
	"subscribe_checkout_diff_request":         {"workspace.read"},
	"checkout.diff.get.request":               {"workspace.read"},
	"file_explorer_request":                   {"workspace.read"},
	"fs.file.subscribe.request":               {"workspace.read"},
	"fs.file.write.request":                   {"workspace.write"},
	"fs.entry.create.request":                 {"workspace.write"},
	"fs.entry.rename.request":                 {"workspace.write"},
	"fs.entry.duplicate.request":              {"workspace.write"},
	"fs.entry.delete.request":                 {"workspace.write"},
	"list_terminals_request":                  {"workspace.read"},
	"subscribe_terminals_request":             {"workspace.read"},
	"unsubscribe_terminals_request":           {"workspace.read"},
	"create_terminal_request":                 {"workspace.write"},
	"terminal.rename.request":                 {"workspace.write"},
	"subscribe_terminal_request":              {"workspace.read"},
	"unsubscribe_terminal_request":            {"workspace.read"},
	"terminal_input":                          {"workspace.write"},
	"kill_terminal_request":                   {"workspace.write"},
	"capture_terminal_request":                {"workspace.read"},
}

// AuthorizeOperation accepts any one of the upstream-required permissions.
// An empty scope grants no permissions, and unknown operations never pass.
func AuthorizeOperation(scope []string, operation string) error {
	allowed, known := operationPermissions[operation]
	if !known {
		return errors.New("gateway operation is unsupported")
	}
	for _, required := range allowed {
		for _, permission := range scope {
			if required == permission {
				return nil
			}
		}
	}
	return errors.New("permission denied")
}
