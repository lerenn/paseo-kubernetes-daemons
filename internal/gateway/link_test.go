package gateway

import "testing"

func TestLinkScopesAndCloses(t *testing.T) {
	link := NewLink([]string{"workspace.read"})
	route, err := link.Open("scope")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := link.Accept(route, Frame{Binary: true, Data: []byte{1}}); err == nil {
		t.Fatal("binary admitted before hello")
	}
	hello := Frame{Data: []byte(`{"type":"hello","clientId":"client","clientType":"browser","protocolVersion":1,"sessionPermissions":["workspace.read","workspace.write"]}`)}
	identity, err := link.Accept(route, hello)
	if err != nil || len(identity.Permissions) != 1 {
		t.Fatalf("identity %+v %v", identity, err)
	}
	read := Frame{Data: []byte(`{"type":"session","message":{"type":"fetch_workspaces_request","requestId":"1"}}`)}
	write := Frame{Data: []byte(`{"type":"session","message":{"type":"fs.file.write.request","requestId":"2"}}`)}
	if _, err := link.Accept(route, read); err != nil {
		t.Fatal(err)
	}
	if _, err := link.Accept(route, write); err == nil {
		t.Fatal("read-only channel can write")
	}
	link.CloseScope("scope")
	if _, err := link.Accept(route, read); err == nil {
		t.Fatal("closed channel accepted data")
	}
	link.Close()
	if _, err := link.Open("another"); err == nil {
		t.Fatal("closed link opened channel")
	}
}

func TestLinkEnforcesChannelLimit(t *testing.T) {
	link := NewLink(nil)
	for i := 0; i < maxLinkChannels; i++ {
		if _, err := link.Open("scope"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := link.Open("scope"); err == nil {
		t.Fatal("channel limit was not enforced")
	}
}
