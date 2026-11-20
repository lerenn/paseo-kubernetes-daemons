package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

// Backend is one connection to one workspace daemon. It deliberately exposes
// raw session frames so protocol fields and event payloads are not discarded.
type Backend struct {
	conn     *websocket.Conn
	ServerID string
	pending  []Frame
}

type Frame struct {
	Binary bool
	Data   []byte
}

var frameCodec = websocket.Codec{
	Marshal: func(v interface{}) ([]byte, byte, error) {
		frame, ok := v.(Frame)
		if !ok {
			return nil, 0, errors.New("invalid frame")
		}
		if frame.Binary {
			return frame.Data, websocket.BinaryFrame, nil
		}
		return frame.Data, websocket.TextFrame, nil
	},
	Unmarshal: func(data []byte, kind byte, v interface{}) error {
		frame, ok := v.(*Frame)
		if !ok || (kind != websocket.BinaryFrame && kind != websocket.TextFrame) {
			return errors.New("unsupported frame")
		}
		frame.Binary = kind == websocket.BinaryFrame
		frame.Data = data
		return nil
	},
}

// DialBackend authenticates to a pod daemon and waits for its server identity.
// endpoint must be supplied by the trusted Kubernetes routing table.
func DialBackend(ctx context.Context, endpoint, clientID, password string) (*Backend, error) {
	if clientID == "" || strings.ContainsAny(endpoint, "/?#@") {
		return nil, errors.New("invalid backend endpoint or client identity")
	}
	location := "ws://" + endpoint + "/ws"
	origin := "http://" + endpoint
	cfg, err := websocket.NewConfig(location, origin)
	if err != nil {
		return nil, errors.New("invalid backend endpoint")
	}
	if _, err := url.ParseRequestURI(location); err != nil {
		return nil, errors.New("invalid backend endpoint")
	}
	conn, err := cfg.DialContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("connect workspace daemon: %w", err)
	}
	conn.MaxPayloadBytes = 1024 * 1024
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	hello := map[string]interface{}{"type": "hello", "clientId": clientID, "clientType": "cli", "protocolVersion": 1}
	if password != "" {
		hello["auth"] = map[string]string{"kind": "password", "password": password}
	}
	if err := websocket.JSON.Send(conn, hello); err != nil {
		conn.Close()
		return nil, fmt.Errorf("send daemon hello: %w", err)
	}
	b := &Backend{conn: conn}
	pendingBytes := 0
	for len(b.pending) < 100 {
		var frame Frame
		if err := frameCodec.Receive(conn, &frame); err != nil {
			conn.Close()
			return nil, fmt.Errorf("receive daemon hello: %w", err)
		}
		var envelope struct {
			Type    string `json:"type"`
			Message struct {
				Type    string `json:"type"`
				Payload struct {
					Status   string `json:"status"`
					ServerID string `json:"serverId"`
				} `json:"payload"`
			} `json:"message"`
		}
		if frame.Binary || json.Unmarshal(frame.Data, &envelope) != nil {
			conn.Close()
			return nil, errors.New("invalid daemon hello response")
		}
		if envelope.Type == "hello.rejected" {
			conn.Close()
			return nil, errors.New("workspace daemon rejected authentication")
		}
		if envelope.Type == "session" && envelope.Message.Type == "status" && envelope.Message.Payload.Status == "server_info" {
			if envelope.Message.Payload.ServerID == "" {
				conn.Close()
				return nil, errors.New("workspace daemon did not identify itself")
			}
			b.ServerID = envelope.Message.Payload.ServerID
			conn.MaxPayloadBytes = websocket.DefaultMaxPayloadBytes
			_ = conn.SetDeadline(time.Time{})
			return b, nil
		}
		pendingBytes += len(frame.Data)
		if pendingBytes > 4*1024*1024 {
			conn.Close()
			return nil, errors.New("workspace daemon sent too much data before hello")
		}
		b.pending = append(b.pending, frame)
	}
	conn.Close()
	return nil, errors.New("workspace daemon sent too many messages before hello")
}

// Receive returns messages in their original order, including any that arrived
// during the handshake. Call it from only one goroutine per backend.
func (b *Backend) Receive() (Frame, error) {
	if len(b.pending) > 0 {
		frame := b.pending[0]
		b.pending = b.pending[1:]
		return frame, nil
	}
	var frame Frame
	err := frameCodec.Receive(b.conn, &frame)
	return frame, err
}

// Send forwards text or binary without changing frame type or payload.
func (b *Backend) Send(frame Frame) error {
	if !frame.Binary && !json.Valid(frame.Data) {
		return errors.New("invalid JSON frame")
	}
	return frameCodec.Send(b.conn, frame)
}
func (b *Backend) SendText(frame []byte) error { return b.Send(Frame{Data: frame}) }
func (b *Backend) Close() error                { return b.conn.Close() }
