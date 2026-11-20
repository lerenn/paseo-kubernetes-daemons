package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type SessionSink interface {
	Enqueue(Frame) error
	Close()
}
type ServerConfig struct {
	Context                                   context.Context
	ServerID, Hostname, Version, Password     string
	AllowedHosts, AllowedOrigins, Permissions []string
	Dispatch                                  func(context.Context, string, ScopedIdentity, Frame) ([]Frame, error)
	OpenSession                               func(context.Context, ScopedIdentity, func(Frame) error) SessionSink
}

var gatewayFeatures = map[string]bool{
	"connectedHosts": true, "hostMultiplexing": true, "workspaceMultiplicity": true,
	"providersSnapshot": true, "providersSnapshotCwd": true, "providerOptionControls": true,
	"workspaceRequestReceipts": true, "agentRequestReceipts": true, "creationLifecycle": true,
	"ownedSubscriptions": true, "terminalCollection": true, "workspaceTerminals": true,
	"binaryChunkingV1": true, "backgroundWorkspaces": true, "backgroundAgents": true,
}

func NewHandler(config ServerConfig) (http.Handler, error) {
	if config.ServerID == "" || config.Password == "" || len(config.AllowedHosts) == 0 || (config.Dispatch == nil && config.OpenSession == nil) {
		return nil, errors.New("gateway identity, password, allowed hosts and session handler are required")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		host := r.Host
		if name, _, err := net.SplitHostPort(host); err == nil {
			host = name
		}
		allowed := false
		for _, name := range config.AllowedHosts {
			if strings.EqualFold(host, name) {
				allowed = true
				break
			}
		}
		if !allowed {
			http.Error(w, "host not allowed", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			parsed, err := url.Parse(origin)
			valid := err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
			allowed = valid && strings.EqualFold(parsed.Host, r.Host)
			for _, value := range config.AllowedOrigins {
				if origin == value {
					allowed = valid
					break
				}
			}
			if !allowed {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
		}
		server := websocket.Server{Handshake: func(*websocket.Config, *http.Request) error { return nil }, Handler: func(ws *websocket.Conn) { serveConnection(r.Context(), ws, config) }}
		server.ServeHTTP(w, r)
	}), nil
}

func serveConnection(parent context.Context, ws *websocket.Conn, config ServerConfig) {
	defer ws.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if config.Context != nil {
		stop := context.AfterFunc(config.Context, func() { cancel(); _ = ws.Close() })
		defer stop()
	}
	ws.MaxPayloadBytes = 64 * 1024
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	var hello Frame
	if frameCodec.Receive(ws, &hello) != nil || hello.Binary {
		return
	}
	identity, err := AuthenticateHello(hello.Data, config.Password)
	if err != nil {
		rejected, _ := textFrame(map[string]interface{}{"type": "hello.rejected", "reason": "incorrect_password", "accepts": []string{"password"}})
		_ = frameCodec.Send(ws, rejected)
		return
	}
	var details struct {
		Capabilities map[string]interface{} `json:"capabilities"`
	}
	_ = json.Unmarshal(hello.Data, &details)
	ws.MaxPayloadBytes = websocket.DefaultMaxPayloadBytes
	_ = ws.SetReadDeadline(time.Time{})
	var writes sync.Mutex
	write := func(frame Frame) error {
		writes.Lock()
		defer writes.Unlock()
		if len(frame.Data) > 32*1024*1024 {
			return errors.New("gateway output frame exceeds limit")
		}
		_ = ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
		err := frameCodec.Send(ws, frame)
		if err != nil {
			cancel()
			_ = ws.Close()
		}
		return err
	}
	info, _ := sessionFrame(map[string]interface{}{"type": "status", "payload": map[string]interface{}{"status": "server_info", "protocolVersion": 1, "serverId": config.ServerID, "hostname": config.Hostname, "version": config.Version, "sourceId": "gateway:" + identity.ClientID, "permissions": config.Permissions, "features": gatewayFeatures}})
	if write(info) != nil {
		return
	}
	link := NewLink(config.Permissions)
	defer link.Close()
	var sessionsMu sync.Mutex
	sessions := map[string]SessionSink{}
	closeSession := func(route string) {
		sessionsMu.Lock()
		session := sessions[route]
		delete(sessions, route)
		sessionsMu.Unlock()
		if session != nil {
			session.Close()
		}
	}
	defer func() {
		sessionsMu.Lock()
		all := make([]SessionSink, 0, len(sessions))
		for _, session := range sessions {
			all = append(all, session)
		}
		sessionsMu.Unlock()
		for _, session := range all {
			session.Close()
		}
	}()
	mux := &Mux{Link: link, ServerID: config.ServerID, Hostname: config.Hostname, Version: config.Version, Features: gatewayFeatures, OnClose: closeSession}
	dispatch := func(ctx context.Context, route string, who ScopedIdentity, frame Frame) ([]Frame, error) {
		if config.OpenSession == nil {
			return config.Dispatch(ctx, route, who, frame)
		}
		sessionsMu.Lock()
		session := sessions[route]
		if session == nil {
			emit := func(reply Frame) error {
				if route != "" {
					if !link.Has(route) {
						return errors.New("host channel closed")
					}
					wrapped, err := mux.wrap(route, reply)
					if err != nil {
						return err
					}
					return write(wrapped)
				}
				return write(reply)
			}
			session = config.OpenSession(ctx, who, emit)
			sessions[route] = session
		}
		sessionsMu.Unlock()
		if err := session.Enqueue(frame); err != nil {
			return []Frame{responseError(frame, err)}, nil
		}
		return nil, nil
	}
	mux.Dispatch = dispatch
	for {
		var frame Frame
		if frameCodec.Receive(ws, &frame) != nil {
			return
		}
		var replies []Frame
		if frame.Binary {
			replies, err = mux.Handle(ctx, frame)
		} else {
			var env struct {
				Type    string `json:"type"`
				Message struct {
					Type string `json:"type"`
				} `json:"message"`
			}
			if json.Unmarshal(frame.Data, &env) != nil {
				return
			}
			if env.Type == "ping" || strings.HasPrefix(env.Message.Type, "hosts.link.") || strings.HasPrefix(env.Message.Type, "hosts.route.") {
				replies, err = mux.Handle(ctx, frame)
			} else {
				if env.Type != "session" {
					return
				}
				if failure := AuthorizeOperation(config.Permissions, env.Message.Type); failure != nil && env.Message.Type != "subscription.release.request" {
					replies = []Frame{responseError(frame, failure)}
				} else {
					replies, err = dispatch(ctx, "", ScopedIdentity{HelloIdentity: identity, Permissions: append([]string(nil), config.Permissions...), Capabilities: details.Capabilities}, frame)
				}
			}
		}
		if err != nil {
			return
		}
		for _, reply := range replies {
			if write(reply) != nil {
				return
			}
		}
	}
}
