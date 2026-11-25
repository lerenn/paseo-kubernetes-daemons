package gateway

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// fakeDaemon answers the owned-subscription requests like a workspace daemon:
// each set_subscription gets a response carrying its own subscriptionId, and
// every received message type is reported on the returned channel.
func fakeDaemon(t *testing.T, upstream string) (string, chan map[string]interface{}) {
	t.Helper()
	seen := make(chan map[string]interface{}, 16)
	srv := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var hello map[string]interface{}
		if websocket.JSON.Receive(ws, &hello) != nil {
			return
		}
		_ = websocket.Message.Send(ws, `{"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"pod-daemon"}}}`)
		for {
			var frame map[string]interface{}
			if websocket.JSON.Receive(ws, &frame) != nil {
				return
			}
			message, _ := frame["message"].(map[string]interface{})
			seen <- message
			id, _ := message["requestId"].(string)
			var reply map[string]interface{}
			switch message["type"] {
			case "session.events.set_subscription.request":
				reply = map[string]interface{}{"type": "session.events.set_subscription.response", "payload": map[string]interface{}{"requestId": id, "subscriptionId": upstream}}
			case "agent.timeline.set_subscription.request":
				reply = map[string]interface{}{"type": "agent.timeline.set_subscription.response", "payload": map[string]interface{}{"requestId": id, "agentIds": []string{}, "subscriptionId": upstream}}
			case "subscription.release.request":
				reply = map[string]interface{}{"type": "subscription.release.response", "payload": map[string]interface{}{"requestId": id, "subscriptionId": message["subscriptionId"]}}
			default:
				continue
			}
			_ = websocket.JSON.Send(ws, map[string]interface{}{"type": "session", "message": reply})
		}
	}))
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://"), seen
}

func TestSetSubscriptionResponsesCarryPublicIDsAndRelease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	address, seen := fakeDaemon(t, "upstream-sub")
	backend, err := DialBackend(ctx, address, "gateway-client", "secret")
	if err != nil {
		t.Fatal(err)
	}
	emitted := make(chan map[string]interface{}, 8)
	session := NewSession(ctx, SessionOptions{Identity: ScopedIdentity{Permissions: []string{"daemon.read", "workspace.read", "workspace.write", "workspace.manage"}}, Emit: func(frame Frame) error {
		_, message, err := messageParts(frame)
		if err != nil {
			return err
		}
		out := map[string]interface{}{}
		for k, v := range message {
			var value interface{}
			_ = json.Unmarshal(v, &value)
			out[k] = value
		}
		emitted <- out
		return nil
	}})
	defer session.Close()
	session.adopt(backend, Target{Name: "pw-a"})
	send := func(body string) map[string]interface{} {
		t.Helper()
		if err := session.handle(Frame{Data: []byte(`{"type":"session","message":` + body + `}`)}); err != nil {
			t.Fatal(err)
		}
		select {
		case message := <-emitted:
			return message
		case <-time.After(5 * time.Second):
			t.Fatal("no response")
			return nil
		}
	}
	publicID := func(response map[string]interface{}, kind string) string {
		t.Helper()
		if response["type"] != kind {
			t.Fatalf("unexpected response %v", response)
		}
		payload := response["payload"].(map[string]interface{})
		id, _ := payload["subscriptionId"].(string)
		if id == "" || id == "upstream-sub" {
			t.Fatalf("%s needs a gateway-owned subscriptionId, got %q", kind, id)
		}
		return id
	}
	events := publicID(send(`{"type":"session.events.set_subscription.request","requestId":"r1","events":["agent_update"]}`), "session.events.set_subscription.response")
	timeline := publicID(send(`{"type":"agent.timeline.set_subscription.request","requestId":"r2","agentIds":[]}`), "agent.timeline.set_subscription.response")
	if events == timeline {
		t.Fatal("subscriptions must have distinct IDs")
	}
	for _, id := range []string{events, timeline} {
		response := send(`{"type":"subscription.release.request","requestId":"rel","subscriptionId":"` + id + `"}`)
		if response["type"] != "subscription.release.response" {
			t.Fatalf("release of %s: %v", id, response)
		}
	}
	released := 0
	for len(seen) > 0 {
		if m := <-seen; m["type"] == "subscription.release.request" {
			if m["subscriptionId"] != "upstream-sub" {
				t.Fatalf("release reached the daemon with %v", m["subscriptionId"])
			}
			released++
		}
	}
	if released != 2 {
		t.Fatalf("daemon saw %d releases", released)
	}
}
