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

func TestBackendHandshakeAndFrames(t *testing.T) {
	received := make(chan map[string]interface{}, 2)
	srv := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var hello map[string]interface{}
		if websocket.JSON.Receive(ws, &hello) != nil {
			return
		}
		received <- hello
		_ = websocket.Message.Send(ws, `{"type":"session","message":{"type":"agent_update","payload":{"value":1}}}`)
		_ = websocket.Message.Send(ws, `{"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"pod-daemon"}}}`)
		var request map[string]interface{}
		if websocket.JSON.Receive(ws, &request) == nil {
			received <- request
		}
		_ = websocket.Message.Send(ws, []byte{0, 1, 2, 255})
		var binary Frame
		if frameCodec.Receive(ws, &binary) == nil {
			received <- map[string]interface{}{"binary": binary.Binary, "length": len(binary.Data)}
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := DialBackend(ctx, strings.TrimPrefix(srv.URL, "http://"), "gateway-client", "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if b.ServerID != "pod-daemon" {
		t.Fatalf("server ID %q", b.ServerID)
	}
	hello := <-received
	auth, ok := hello["auth"].(map[string]interface{})
	if !ok || auth["password"] != "secret" {
		t.Fatal("missing backend authentication")
	}
	frame, err := b.Receive()
	if err != nil || frame.Binary || !strings.Contains(string(frame.Data), "agent_update") {
		t.Fatalf("lost early event %v %v", frame, err)
	}
	request := []byte(`{"type":"session","message":{"type":"fetch_agents_request","requestId":"1"}}`)
	if err := b.SendText(request); err != nil {
		t.Fatal(err)
	}
	if err := b.SendText([]byte(`not-json`)); err == nil {
		t.Fatal("accepted invalid frame")
	}
	got := <-received
	var expected map[string]interface{}
	_ = json.Unmarshal(request, &expected)
	if got["type"] != expected["type"] {
		t.Fatal("request not forwarded")
	}
	binary, err := b.Receive()
	if err != nil || !binary.Binary || len(binary.Data) != 4 || binary.Data[3] != 255 {
		t.Fatalf("binary receive %v %v", binary, err)
	}
	if err := b.Send(Frame{Binary: true, Data: []byte{1, 2, 3}}); err != nil {
		t.Fatal(err)
	}
	got = <-received
	if got["binary"] != true || got["length"] != 3 {
		t.Fatal("binary frame type or data lost")
	}
}

func TestBackendRejectsAuthentication(t *testing.T) {
	srv := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var hello map[string]interface{}
		_ = websocket.JSON.Receive(ws, &hello)
		_ = websocket.Message.Send(ws, `{"type":"hello.rejected","reason":"incorrect_password","accepts":["password"]}`)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := DialBackend(ctx, strings.TrimPrefix(srv.URL, "http://"), "client", "wrong"); err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("unexpected error %v", err)
	}
}
