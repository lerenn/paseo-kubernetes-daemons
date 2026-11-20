package gateway

import (
	"encoding/json"
	"errors"
)

// PrepareCreate translates a creation request for a project already mapped to
// a synced profile. It never guesses a repository from a client-provided path.
func PrepareCreate(frame []byte, projectID, projectRoot string) ([]byte, error) {
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
	podRoot, _ := json.Marshal("/workspace/repository")
	if kind == "directory" {
		source["path"] = podRoot
	} else {
		source["cwd"] = podRoot
	}
	translated, err := json.Marshal(source)
	if err != nil {
		return nil, err
	}
	envelope.Message["source"] = translated
	return json.Marshal(envelope)
}
