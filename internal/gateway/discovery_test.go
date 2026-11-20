package gateway

import (
	"context"
	"encoding/json"
	"testing"
)

func TestDiscoverApprovedProject(t *testing.T) {
	p := fixture(t, true)
	data, err := p.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if data.Project == nil || data.Project.Name != "b" || data.Project.Repository != "https://example.com/a/b" {
		t.Fatalf("project %+v", data.Project)
	}
	first, err := data.ProjectList("request-1")
	if err != nil || !json.Valid(first.Data) {
		t.Fatal("invalid project response")
	}
	second, err := p.Discover(context.Background())
	if err != nil || second.Project.ID != data.Project.ID {
		t.Fatal("project identity is not stable")
	}
	if frame, err := data.ProviderSnapshot("request-2"); err != nil || !json.Valid(frame.Data) {
		t.Fatal("invalid provider response")
	}
}

func TestHandleDiscoveryCorrelatesResponses(t *testing.T) {
	p := fixture(t, true)
	frame, err := p.HandleDiscovery(context.Background(), Frame{Data: []byte(`{"type":"session","message":{"type":"project.list.request","requestId":"r1"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Message struct {
			Type    string `json:"type"`
			Payload struct {
				RequestID string `json:"requestId"`
				Projects  []struct {
					ID string `json:"projectId"`
				} `json:"projects"`
			} `json:"payload"`
		} `json:"message"`
	}
	if json.Unmarshal(frame.Data, &result) != nil || result.Message.Type != "project.list.response" || result.Message.Payload.RequestID != "r1" || len(result.Message.Payload.Projects) != 1 {
		t.Fatalf("bad result: %s", frame.Data)
	}
}
