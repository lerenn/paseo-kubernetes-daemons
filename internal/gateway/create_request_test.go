package gateway

import (
	"encoding/json"
	"testing"
)

func TestPrepareCreateRetainsIntentAndMapsProject(t *testing.T) {
	frame := []byte(`{"type":"session","message":{"type":"workspace.create.request","requestId":"r1","source":{"kind":"worktree","projectId":"project-1","cwd":"/virtual/project","action":"branch-off","refName":"main"},"agent":{"initialPrompt":"hello","config":{"provider":"codex","cwd":"/virtual/project/src"}}}}`)
	output, err := PrepareCreate(frame, "project-1", "/virtual/project")
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Message struct {
			RequestID string                 `json:"requestId"`
			Agent     map[string]interface{} `json:"agent"`
			Source    map[string]interface{} `json:"source"`
		} `json:"message"`
	}
	if err := json.Unmarshal(output, &value); err != nil {
		t.Fatal(err)
	}
	if value.Message.RequestID != "r1" || value.Message.Agent["initialPrompt"] != "hello" || value.Message.Source["cwd"] != "/workspace/repository" || value.Message.Source["refName"] != "main" || value.Message.Source["projectId"] != nil {
		t.Fatalf("wrong translated request: %s", output)
	}
	if config, ok := value.Message.Agent["config"].(map[string]interface{}); !ok || config["cwd"] != "/workspace/repository/src" {
		t.Fatalf("agent cwd not translated: %s", output)
	}
}

func TestPrepareCreateRejectsDifferentProjectOrPath(t *testing.T) {
	for _, source := range []string{`{"kind":"directory","path":"/other"}`, `{"kind":"worktree","projectId":"other"}`, `{"kind":"worktree"}`} {
		frame := []byte(`{"type":"session","message":{"type":"workspace.create.request","source":` + source + `}}`)
		if _, err := PrepareCreate(frame, "project-1", "/virtual/project"); err == nil {
			t.Fatalf("accepted %s", source)
		}
	}
	frame := []byte(`{"type":"session","message":{"type":"workspace.create.request","source":{"kind":"directory","path":"/virtual/project"},"agent":{"config":{"cwd":"/virtual/project/../../etc"}}}}`)
	if _, err := PrepareCreate(frame, "project-1", "/virtual/project"); err == nil {
		t.Fatal("accepted unsafe agent cwd")
	}
}
