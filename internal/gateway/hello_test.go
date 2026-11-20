package gateway

import (
	"strings"
	"testing"
)

func TestAuthenticateHello(t *testing.T) {
	valid := `{"type":"hello","clientId":"client-1","clientType":"browser","protocolVersion":1,"auth":{"kind":"password","password":"secret"}}`
	identity, err := AuthenticateHello([]byte(valid), "secret")
	if err != nil || identity.ClientID != "client-1" {
		t.Fatalf("%+v %v", identity, err)
	}
	for _, bad := range []string{
		valid,
		`{"type":"hello","clientId":"client-1","clientType":"browser","protocolVersion":0,"auth":{"kind":"password","password":"secret"}}`,
		`{"type":"hello","clientId":"plugin:other","clientType":"cli","protocolVersion":1,"auth":{"kind":"password","password":"secret"}}`,
		`{"type":"hello","clientId":"client-1","clientType":"cli","protocolVersion":1,"sessionPermissions":[],"auth":{"kind":"password","password":"secret"}}`,
	} {
		password := "secret"
		if bad == valid {
			password = "wrong"
		}
		if _, err := AuthenticateHello([]byte(bad), password); err == nil {
			t.Fatal("accepted invalid hello")
		}
	}
	if _, err := AuthenticateHello([]byte(valid), ""); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("empty password should fail without leaking credentials")
	}
}
