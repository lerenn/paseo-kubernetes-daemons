package gateway

import (
	"encoding/json"
	"errors"
	"path"
	"strings"
)

// PrepareCreate translates a creation request for a project already mapped to
// a synced profile. It never guesses a repository from a client-provided path.
func PrepareCreate(frame []byte, projectID, projectRoot string) ([]byte, error) {
	return prepareCreateAt(frame, projectID, projectRoot, "/workspace/repository")
}

func prepareCreateAt(frame []byte, projectID, projectRoot, podDirectory string) ([]byte, error) {
	if projectID == "" || projectRoot == "" {
		return nil, errors.New("approved project mapping is required")
	}
	var envelope struct {
		Type    string                     `json:"type"`
		Message map[string]json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil || envelope.Type != "session" {
		return nil, errors.New("invalid session frame")
	}
	var operation string
	if json.Unmarshal(envelope.Message["type"], &operation) != nil || operation != "workspace.create.request" {
		return nil, errors.New("expected workspace creation")
	}
	var source map[string]json.RawMessage
	if json.Unmarshal(envelope.Message["source"], &source) != nil || source == nil {
		return nil, errors.New("invalid workspace source")
	}
	var kind, requestedProject, sourcePath string
	_ = json.Unmarshal(source["kind"], &kind)
	_ = json.Unmarshal(source["projectId"], &requestedProject)
	switch kind {
	case "directory":
		_ = json.Unmarshal(source["path"], &sourcePath)
	case "worktree":
		_ = json.Unmarshal(source["cwd"], &sourcePath)
	default:
		return nil, errors.New("unsupported workspace source")
	}
	if requestedProject != "" && requestedProject != projectID {
		return nil, errors.New("requested project is not approved in the synced profile")
	}
	if sourcePath != "" && sourcePath != projectRoot {
		return nil, errors.New("requested path is not approved in the synced profile")
	}
	if requestedProject == "" && sourcePath == "" {
		return nil, errors.New("workspace source does not identify an approved project")
	}
	// The pod has its own project registry; the virtual host's project ID must
	// not be passed to it. Preserve worktree branch/ref and all other fields.
	delete(source, "projectId")
	podRoot, _ := json.Marshal(podDirectory)
	if kind == "directory" {
		source["path"] = podRoot
	} else {
		source["cwd"] = podRoot
	}
	if raw, ok := envelope.Message["agent"]; ok && string(raw) != "null" {
		var agent map[string]json.RawMessage
		if json.Unmarshal(raw, &agent) != nil || agent == nil {
			return nil, errors.New("invalid initial agent")
		}
		var config map[string]json.RawMessage
		if json.Unmarshal(agent["config"], &config) != nil || config == nil {
			return nil, errors.New("invalid initial agent configuration")
		}
		var cwd string
		if json.Unmarshal(config["cwd"], &cwd) != nil || path.Clean(cwd) != cwd || (cwd != projectRoot && !strings.HasPrefix(cwd, projectRoot+"/")) {
			return nil, errors.New("initial agent directory is outside the approved project")
		}
		mapped, _ := json.Marshal(podDirectory + strings.TrimPrefix(cwd, projectRoot))
		config["cwd"] = mapped
		configRaw, err := json.Marshal(config)
		if err != nil {
			return nil, err
		}
		agent["config"] = configRaw
		agentRaw, err := json.Marshal(agent)
		if err != nil {
			return nil, err
		}
		envelope.Message["agent"] = agentRaw
	}
	translated, err := json.Marshal(source)
	if err != nil {
		return nil, err
	}
	envelope.Message["source"] = translated
	return json.Marshal(envelope)
}
