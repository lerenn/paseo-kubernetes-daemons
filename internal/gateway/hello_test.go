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

func TestLinkedHelloNeverElevatesParent(t *testing.T) {
	frame := []byte(`{"type":"hello","clientId":"routed-client","clientType":"browser","protocolVersion":1,"routed":true,"sessionPermissions":["workspace.read","workspace.write"]}`)
	identity, err := AdmitLinkedHello(frame, []string{"workspace.read"})
	if err != nil {
		t.Fatal(err)
	}
	if len(identity.Permissions) != 1 || identity.Permissions[0] != "workspace.read" {
		t.Fatalf("permission escalation: %v", identity.Permissions)
	}
	if err := AuthorizeOperation(identity.Permissions, "fs.file.write.request"); err == nil {
		t.Fatal("linked read-only client can write")
	}
	frame = []byte(`{"type":"hello","clientId":"routed-client","clientType":"browser","protocolVersion":1,"sessionPermissions":[]}`)
	identity, err = AdmitLinkedHello(frame, []string{"workspace.read"})
	if err != nil || len(identity.Permissions) != 0 {
		t.Fatal("empty scope should grant nothing")
	}
}
