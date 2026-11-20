package gateway

import (
	"context"
	"testing"
)

func TestObserveCreationRecordsOnlyMatchingResponse(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	name := ready(t, p, "creation", "pod")
	frame := []byte(`{"type":"session","message":{"type":"workspace.create.response","payload":{"requestId":"r1","error":null,"workspace":{"id":"w1"},"agent":{"id":"a1","workspaceId":"w1"},"setupTerminalId":"t1"}}}`)
	if err := p.ObserveCreation(ctx, name, "pod", "other", frame); err == nil {
		t.Fatal("accepted unrelated response")
	}
	if err := p.ObserveCreation(ctx, name, "pod", "r1", frame); err != nil {
		t.Fatal(err)
	}
	for kind, id := range map[string]string{"workspace": "w1", "agent": "a1", "terminal": "t1"} {
		if _, err := p.Resolve(ctx, kind, id); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
	}
}

func TestObserveCreationRejectsAgentFromOtherWorkspace(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	name := ready(t, p, "creation", "pod")
	frame := []byte(`{"type":"session","message":{"type":"workspace.create.response","payload":{"requestId":"r1","error":null,"workspace":{"id":"w1"},"agent":{"id":"a1","workspaceId":"other"}}}}`)
	if err := p.ObserveCreation(ctx, name, "pod", "r1", frame); err == nil {
		t.Fatal("accepted mismatched agent")
	}
	if _, err := p.Resolve(ctx, "workspace", "w1"); err == nil {
		t.Fatal("stored invalid route")
	}
}
