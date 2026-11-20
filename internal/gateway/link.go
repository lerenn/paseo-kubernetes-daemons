package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
)

const maxLinkChannels = 128
const maxLinkFrameBytes = (32*1024*1024 - (3 + maxHostRouteIDBytes)) / 6

type linkChannel struct {
	scope    string
	identity *ScopedIdentity
}

// Link owns channels under one already authenticated physical connection.
// No channel can acquire more permissions than that connection.
type Link struct {
	mu          sync.Mutex
	closed      bool
	permissions []string
	channels    map[string]*linkChannel
}

func NewLink(permissions []string) *Link {
	return &Link{permissions: append([]string(nil), permissions...), channels: make(map[string]*linkChannel)}
}

func (l *Link) Open(scope string) (string, error) {
	if len(scope) == 0 || len(scope) > 256 {
		return "", errors.New("invalid channel scope")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return "", errors.New("host link is closed")
	}
	if len(l.channels) >= maxLinkChannels {
		return "", errors.New("too many host channels")
	}
	var id [16]byte
	for {
		if _, err := rand.Read(id[:]); err != nil {
			return "", err
		}
		name := hex.EncodeToString(id[:])
		if _, exists := l.channels[name]; !exists {
			l.channels[name] = &linkChannel{scope: scope}
			return name, nil
		}
	}
}

// Accept authenticates the first logical hello and authorizes subsequent
// session operations. Binary input is rejected until transfer ownership is
// implemented; outgoing binary frames are handled separately.
func (l *Link) Accept(routeID string, frame Frame) (*ScopedIdentity, error) {
	if len(frame.Data) > maxLinkFrameBytes {
		return nil, errors.New("host channel frame exceeds limit")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	channel := l.channels[routeID]
	if l.closed || channel == nil {
		return nil, errors.New("host channel is closed")
	}
	if channel.identity == nil {
		if frame.Binary {
			return nil, errors.New("first channel frame must be hello")
		}
		identity, err := AdmitLinkedHello(frame.Data, l.permissions)
		if err != nil {
			return nil, err
		}
		channel.identity = &identity
		return cloneIdentity(channel.identity), nil
	}
	if frame.Binary {
		return nil, errors.New("binary input requires transfer ownership")
	}
	var message struct {
		Type    string `json:"type"`
		Message struct {
			Type string `json:"type"`
		} `json:"message"`
	}
	if json.Unmarshal(frame.Data, &message) != nil {
		return nil, errors.New("invalid host channel frame")
	}
	if message.Type == "ping" {
		return cloneIdentity(channel.identity), nil
	}
	if message.Type != "session" || message.Message.Type == "" {
		return nil, errors.New("invalid host channel session")
	}
	if err := AuthorizeOperation(channel.identity.Permissions, message.Message.Type); err != nil && message.Message.Type != "subscription.release.request" {
		return nil, err
	}
	return cloneIdentity(channel.identity), nil
}

func cloneIdentity(in *ScopedIdentity) *ScopedIdentity {
	out := *in
	out.Permissions = append([]string(nil), in.Permissions...)
	return &out
}

func (l *Link) Has(route string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.closed && l.channels[route] != nil
}
func (l *Link) ScopeRoutes(scope string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var ids []string
	for id, ch := range l.channels {
		if ch.scope == scope {
			ids = append(ids, id)
		}
	}
	return ids
}

func (l *Link) CloseRoute(routeID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.channels, routeID)
}
func (l *Link) CloseScope(scope string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, ch := range l.channels {
		if ch.scope == scope {
			delete(l.channels, id)
		}
	}
}
func (l *Link) Close() { l.mu.Lock(); defer l.mu.Unlock(); l.closed = true; clear(l.channels) }
