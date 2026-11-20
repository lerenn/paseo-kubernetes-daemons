package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Mux implements the host-link framing for one authenticated physical
// connection. Dispatch must enforce resource ownership in addition to the
// channel's permission scope. Its returned frames are sent to that channel.
type Mux struct {
	Link     *Link
	ServerID string
	Hostname string
	Version  string
	Dispatch func(context.Context, string, ScopedIdentity, Frame) ([]Frame, error)
	OnClose  func(string)
	Features map[string]bool
}

func textFrame(value interface{}) (Frame, error) {
	data, err := json.Marshal(value)
	return Frame{Data: data}, err
}
func sessionFrame(message interface{}) (Frame, error) {
	return textFrame(map[string]interface{}{"type": "session", "message": message})
}

func (m *Mux) wrap(route string, frame Frame) (Frame, error) {
	if frame.Binary {
		data, err := EncodeHostFrame(route, frame.Data)
		return Frame{Binary: true, Data: data}, err
	}
	if !json.Valid(frame.Data) {
		return Frame{}, errors.New("invalid child session frame")
	}
	return sessionFrame(map[string]interface{}{"type": "hosts.route.frame", "payload": map[string]interface{}{"subscriptionId": route, "data": string(frame.Data), "binary": false}})
}

func (m *Mux) closeRoute(route, code, reason string) (Frame, error) {
	m.Link.CloseRoute(route)
	if m.OnClose != nil {
		m.OnClose(route)
	}
	return sessionFrame(map[string]interface{}{"type": "hosts.route.closed", "payload": map[string]interface{}{"subscriptionId": route, "code": code, "message": reason}})
}

// Handle processes one outer frame and returns its immediate replies. A
// transport must serialize writes and close the link when disconnected.
func (m *Mux) Handle(ctx context.Context, frame Frame) ([]Frame, error) {
	if m.Link == nil || m.ServerID == "" {
		return nil, errors.New("host link is not configured")
	}
	if frame.Binary {
		route, data, err := DecodeHostFrame(frame.Data)
		if err != nil {
			return nil, err
		}
		return m.child(ctx, route, Frame{Binary: true, Data: data})
	}
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
			ChannelID string `json:"channelId"`
			RouteID   string `json:"routeId"`
			ScopeID   string `json:"scopeId"`
			Data      string `json:"data"`
			Binary    bool   `json:"binary"`
		} `json:"message"`
	}
	if json.Unmarshal(frame.Data, &env) != nil {
		return nil, errors.New("invalid host link frame")
	}
	if env.Type == "ping" {
		f, err := textFrame(map[string]string{"type": "pong"})
		return []Frame{f}, err
	}
	if env.Type != "session" {
		return nil, errors.New("invalid host link session")
	}
	msg := env.Message
	switch msg.Type {
	case "hosts.link.open.request":
		if msg.RequestID == "" {
			return nil, errors.New("missing request ID")
		}
		route, err := m.Link.Open(msg.ChannelID)
		if err != nil {
			return nil, err
		}
		response, err := sessionFrame(map[string]interface{}{"type": "hosts.link.open.response", "payload": map[string]string{"requestId": msg.RequestID, "routeId": route}})
		return []Frame{response}, err
	case "hosts.route.frame.request":
		if msg.Binary || msg.RouteID == "" {
			return nil, errors.New("invalid routed text frame")
		}
		return m.child(ctx, msg.RouteID, Frame{Data: []byte(msg.Data)})
	case "hosts.route.close.request":
		if msg.RouteID != "" {
			m.Link.CloseRoute(msg.RouteID)
			if m.OnClose != nil {
				m.OnClose(msg.RouteID)
			}
		} else if msg.ScopeID != "" {
			ids := m.Link.ScopeRoutes(msg.ScopeID)
			m.Link.CloseScope(msg.ScopeID)
			if m.OnClose != nil {
				for _, id := range ids {
					m.OnClose(id)
				}
			}
		} else {
			return nil, errors.New("missing route or scope")
		}
		return nil, nil
	default:
		return nil, fmt.Errorf("unsupported host link operation %q", msg.Type)
	}
}

func (m *Mux) child(ctx context.Context, route string, frame Frame) ([]Frame, error) {
	identity, err := m.Link.Accept(route, frame)
	if err != nil {
		closed, e := m.closeRoute(route, "permission_denied", "Host channel rejected the request")
		return []Frame{closed}, e
	}
	var marker struct {
		Type string `json:"type"`
	}
	if !frame.Binary {
		_ = json.Unmarshal(frame.Data, &marker)
	}
	if marker.Type == "hello" {
		features := m.Features
		if features == nil {
			features = map[string]bool{"connectedHosts": true, "hostMultiplexing": true}
		}
		info, err := sessionFrame(map[string]interface{}{"type": "status", "payload": map[string]interface{}{"status": "server_info", "protocolVersion": 1, "serverId": m.ServerID, "hostname": m.Hostname, "version": m.Version, "sourceId": "gateway:" + identity.ClientID, "permissions": identity.Permissions, "features": features}})
		if err != nil {
			return nil, err
		}
		wrapped, err := m.wrap(route, info)
		return []Frame{wrapped}, err
	}
	if marker.Type == "ping" {
		pong, err := textFrame(map[string]string{"type": "pong"})
		if err != nil {
			return nil, err
		}
		wrapped, err := m.wrap(route, pong)
		return []Frame{wrapped}, err
	}
	if m.Dispatch == nil {
		return nil, errors.New("host channel dispatcher is unavailable")
	}
	output, err := m.Dispatch(ctx, route, *identity, frame)
	if err != nil {
		return nil, err
	}
	result := make([]Frame, 0, len(output))
	for _, item := range output {
		wrapped, err := m.wrap(route, item)
		if err != nil {
			return nil, err
		}
		result = append(result, wrapped)
	}
	return result, nil
}
