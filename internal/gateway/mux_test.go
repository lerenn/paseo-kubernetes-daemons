package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMuxOpensScopedHostChannel(t *testing.T) {
	ctx := context.Background()
	dispatched := false
	mux := Mux{Link: NewLink([]string{"workspace.read"}), ServerID: "gateway-id", Hostname: "lab", Version: "0.16.2", Dispatch: func(_ context.Context, route string, identity ScopedIdentity, frame Frame) ([]Frame, error) {
		dispatched = true
		if len(identity.Permissions) != 1 || identity.Permissions[0] != "workspace.read" {
			t.Fatal("scope changed")
		}
		return []Frame{{Data: []byte(`{"type":"session","message":{"type":"fetch_workspaces_response","payload":{"requestId":"r"}}}`)}}, nil
	}}
	open, err := mux.Handle(ctx, Frame{Data: []byte(`{"type":"session","message":{"type":"hosts.link.open.request","requestId":"open","channelId":"scope","flowControl":true}}`)})
	if err != nil || len(open) != 1 {
		t.Fatalf("%v %v", open, err)
	}
	var result struct {
		Message struct {
			Payload struct {
				Route string `json:"routeId"`
			} `json:"payload"`
		} `json:"message"`
	}
	if err := json.Unmarshal(open[0].Data, &result); err != nil || result.Message.Payload.Route == "" {
		t.Fatal("missing route")
	}
	route := result.Message.Payload.Route
	child := func(data string) Frame {
		bytes, _ := json.Marshal(map[string]interface{}{"type": "session", "message": map[string]interface{}{"type": "hosts.route.frame.request", "routeId": route, "data": data, "binary": false}})
		return Frame{Data: bytes}
	}
	hello := `{"type":"hello","clientId":"client","clientType":"browser","protocolVersion":1,"sessionPermissions":["workspace.read","workspace.write"]}`
	frames, err := mux.Handle(ctx, child(hello))
	if err != nil || len(frames) != 1 || !strings.Contains(string(frames[0].Data), "gateway-id") {
		t.Fatalf("hello: %v %v", frames, err)
	}
	read := `{"type":"session","message":{"type":"fetch_workspaces_request","requestId":"r"}}`
	frames, err = mux.Handle(ctx, child(read))
	if err != nil || !dispatched || len(frames) != 1 || !strings.Contains(string(frames[0].Data), "fetch_workspaces_response") {
		t.Fatalf("read: %v %v", frames, err)
	}
	write := `{"type":"session","message":{"type":"fs.file.write.request","requestId":"r"}}`
	frames, err = mux.Handle(ctx, child(write))
	if err != nil || len(frames) != 1 || !strings.Contains(string(frames[0].Data), "access_denied") || strings.Contains(string(frames[0].Data), "hosts.route.closed") {
		t.Fatalf("write should be denied without closing the channel: %v %v", frames, err)
	}
	frames, err = mux.Handle(ctx, child(read))
	if err != nil || len(frames) != 1 || !strings.Contains(string(frames[0].Data), "fetch_workspaces_response") {
		t.Fatalf("channel should survive a denied request: %v %v", frames, err)
	}
}
