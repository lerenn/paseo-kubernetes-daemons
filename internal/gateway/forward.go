package gateway

import (
	"encoding/json"
	"errors"
)

// TranslateBackendFrame preserves user content and opaque protocol extensions.
// Workspace mounts already have routable paths; only project projections and
// compatibility paths in known descriptor fields need translation.
func TranslateBackendFrame(frame Frame, target Target) (Frame, error) {
	if frame.Binary {
		return frame, nil
	}
	envelope, message, err := messageParts(frame)
	if err != nil {
		return Frame{}, err
	}
	payload := objectValue(message, "payload")
	if payload == nil {
		return frame, nil
	}
	workspace := func(w wireObject) error {
		setString(w, "projectId", target.Project.ID)
		setString(w, "projectRootPath", target.Project.Root)
		return virtualField(w, "workspaceDirectory", target.Name)
	}
	agent := func(a wireObject) error { return virtualField(a, "cwd", target.Name) }
	for _, key := range []string{"agent", "info"} {
		if err := objectField(payload, key, agent); err != nil {
			return Frame{}, err
		}
	}
	if err := objectField(payload, "workspace", workspace); err != nil {
		return Frame{}, err
	}
	if err := objectField(payload, "creation", func(c wireObject) error {
		if err := objectField(c, "workspace", workspace); err != nil {
			return err
		}
		return objectField(c, "agent", agent)
	}); err != nil {
		return Frame{}, err
	}
	for _, key := range []string{"entries", "agents", "terminals"} {
		raw, ok := payload[key]
		if !ok {
			continue
		}
		var entries []wireObject
		if json.Unmarshal(raw, &entries) != nil {
			continue
		}
		for _, entry := range entries {
			if _, ok := entry["projectRootPath"]; ok {
				if err := workspace(entry); err != nil {
					return Frame{}, err
				}
			}
			if _, ok := entry["cwd"]; ok {
				if err := agent(entry); err != nil {
					return Frame{}, err
				}
			}
			if err := objectField(entry, "agent", agent); err != nil {
				return Frame{}, err
			}
		}
		data, err := json.Marshal(entries)
		if err != nil {
			return Frame{}, err
		}
		payload[key] = data
	}
	if _, ok := payload["cwd"]; ok {
		if err := virtualField(payload, "cwd", target.Name); err != nil {
			return Frame{}, err
		}
	}
	if err := objectField(payload, "version", func(v wireObject) error { return virtualField(v, "cwd", target.Name) }); err != nil {
		return Frame{}, err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return Frame{}, err
	}
	message["payload"] = data
	if stringField(message, "type") == "workspace_update" && stringField(payload, "kind") == "remove" {
		// Empty-project projections from a pod are replaced by the gateway's
		// project catalog, which outlives every individual environment.
		delete(payload, "emptyProject")
		delete(payload, "removedProjectId")
		data, _ = json.Marshal(payload)
		message["payload"] = data
	}
	return encodeMessage(envelope, message), nil
}

func responseError(request Frame, err error) Frame {
	_, message, _ := messageParts(request)
	if message == nil {
		message = wireObject{}
	}
	result, _ := sessionFrame(map[string]interface{}{"type": "rpc_error", "payload": map[string]string{"requestId": stringField(message, "requestId"), "requestType": stringField(message, "type"), "code": "gateway_error", "error": err.Error()}})
	return result
}

func routingError() error { return errors.New("request does not identify a Kubernetes workspace") }
