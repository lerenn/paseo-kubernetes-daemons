package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTranslateCreationFrameLeavesUserContent(t *testing.T) {
	frame := Frame{Data: []byte(`{"type":"session","message":{"type":"workspace.create.response","payload":{"requestId":"r","workspace":{"id":"w","projectId":"pod-project","projectRootPath":"/workspace/repository","workspaceDirectory":"/workspace/repository","title":"/workspace/repository"},"agent":{"id":"a","cwd":"/workspace/repository"}}}}`)}
	result, err := TranslateCreationFrame(frame, "gw-1", Project{ID: "project-1", Root: "/projects/project-1"})
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Message struct {
			Payload struct {
				Workspace map[string]interface{} `json:"workspace"`
				Agent     map[string]interface{} `json:"agent"`
			} `json:"payload"`
		} `json:"message"`
	}
	if json.Unmarshal(result.Data, &value) != nil {
		t.Fatal("bad JSON")
	}
	w := value.Message.Payload.Workspace
	if w["projectId"] != "project-1" || w["projectRootPath"] != "/projects/project-1" || w["title"] != "/workspace/repository" || !strings.Contains(w["workspaceDirectory"].(string), "gw-1") || !strings.Contains(value.Message.Payload.Agent["cwd"].(string), "gw-1") {
		t.Fatalf("bad translation %s", result.Data)
	}
}
