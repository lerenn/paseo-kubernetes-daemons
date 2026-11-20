package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

// RoutePathRequest handles operations whose cwd is a host-visible workspace
// path. Only an explicit allowlist is rewritten; text and file contents are
// never scanned for paths.
func (p *Provisioner) RoutePathRequest(ctx context.Context, frame []byte) (string, []byte, error) {
	var envelope struct {
		Type    string                     `json:"type"`
		Message map[string]json.RawMessage `json:"message"`
	}
	if json.Unmarshal(frame, &envelope) != nil || envelope.Type != "session" || envelope.Message == nil {
		return "", nil, errors.New("invalid session frame")
	}
	var op, cwd string
	if json.Unmarshal(envelope.Message["type"], &op) != nil || json.Unmarshal(envelope.Message["cwd"], &cwd) != nil {
		return "", nil, errors.New("operation and cwd are required")
	}
	switch op {
	case "checkout_status_request", "subscribe_checkout_diff_request", "checkout.diff.get.request", "file_explorer_request", "fs.file.subscribe.request", "fs.file.write.request", "fs.entry.create.request", "fs.entry.rename.request", "fs.entry.duplicate.request", "fs.entry.delete.request", "list_terminals_request", "subscribe_terminals_request", "unsubscribe_terminals_request", "create_terminal_request":
	default:
		return "", nil, fmt.Errorf("path routing does not support operation %q", op)
	}
	environment, real, err := ParseVirtualPath(cwd)
	if err != nil {
		return "", nil, err
	}
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(controller.GVK)
	if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: environment}, obj); err != nil {
		return "", nil, fmt.Errorf("find workspace: %w", err)
	}
	var routes Routes
	if json.Unmarshal([]byte(obj.GetAnnotations()[routesAnnotation]), &routes) != nil || routes.Workspace == "" {
		return "", nil, errors.New("workspace routes are unavailable")
	}
	endpoint, err := p.Resolve(ctx, "workspace", routes.Workspace)
	if err != nil {
		return "", nil, err
	}
	// When the request also carries an entity identity, both must point to the
	// same backend. A new terminal has no terminalId yet.
	for field, kind := range map[string]string{"workspaceId": "workspace", "agentId": "agent"} {
		raw, ok := envelope.Message[field]
		if !ok || string(raw) == "null" {
			continue
		}
		var id string
		if json.Unmarshal(raw, &id) != nil {
			return "", nil, fmt.Errorf("invalid %s", field)
		}
		other, err := p.Resolve(ctx, kind, id)
		if err != nil || other != endpoint {
			return "", nil, errors.New("request identities point to different or unknown workspaces")
		}
	}
	value, _ := json.Marshal(real)
	envelope.Message["cwd"] = value
	translated, err := json.Marshal(envelope)
	if err != nil {
		return "", nil, err
	}
	return endpoint, translated, nil
}
