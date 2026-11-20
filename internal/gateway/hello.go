package gateway

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"
)

type HelloIdentity struct {
	ClientID   string
	ClientType string
}

// AuthenticateHello validates the gateway-facing Paseo handshake. The caller
// must configure a strong shared password; uncredentialed operation is not
// supported. Scoped/routed credentials are rejected until permission checks
// are implemented for every forwarded operation.
func AuthenticateHello(frame []byte, password string) (HelloIdentity, error) {
	if password == "" {
		return HelloIdentity{}, errors.New("gateway password is not configured")
	}
	var hello struct {
		Type        string          `json:"type"`
		ClientID    string          `json:"clientId"`
		ClientType  string          `json:"clientType"`
		Protocol    int             `json:"protocolVersion"`
		Routed      bool            `json:"routed"`
		Producer    json.RawMessage `json:"producer"`
		Permissions json.RawMessage `json:"sessionPermissions"`
		Auth        struct {
			Kind     string `json:"kind"`
			Password string `json:"password"`
		} `json:"auth"`
	}
	if len(frame) > 64*1024 || json.Unmarshal(frame, &hello) != nil || hello.Type != "hello" {
		return HelloIdentity{}, errors.New("invalid hello")
	}
	if hello.Protocol < 1 {
		return HelloIdentity{}, errors.New("incompatible protocol")
	}
	if strings.TrimSpace(hello.ClientID) != hello.ClientID || hello.ClientID == "" || len(hello.ClientID) > 256 || strings.HasPrefix(hello.ClientID, "plugin:") {
		return HelloIdentity{}, errors.New("invalid client identity")
	}
	switch hello.ClientType {
	case "browser", "mobile", "cli", "mcp", "hub":
	default:
		return HelloIdentity{}, errors.New("invalid client type")
	}
	if hello.Routed || len(hello.Producer) > 0 || len(hello.Permissions) > 0 {
		return HelloIdentity{}, errors.New("scoped or routed sessions are not supported")
	}
	actual, expected := sha256.Sum256([]byte(hello.Auth.Password)), sha256.Sum256([]byte(password))
	if hello.Auth.Kind != "password" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
		return HelloIdentity{}, errors.New("authentication failed")
	}
	return HelloIdentity{ClientID: hello.ClientID, ClientType: hello.ClientType}, nil
}
