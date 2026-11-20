package gateway

import (
	"bytes"
	"testing"
)

func TestHostFrameRoundTrip(t *testing.T) {
	payload := []byte{0, 1, 2, 255}
	wire, err := EncodeHostFrame("route-123", payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(wire[:3], []byte{0x30, 0, 9}) {
		t.Fatalf("wrong header %v", wire[:3])
	}
	id, decoded, err := DecodeHostFrame(wire)
	if err != nil || id != "route-123" || !bytes.Equal(decoded, payload) {
		t.Fatalf("%q %v %v", id, decoded, err)
	}
}
func TestHostFrameRejectsInvalid(t *testing.T) {
	for _, frame := range [][]byte{{}, {0x30, 0, 0}, {0x30, 0, 2, 'a'}, {0x30, 0, 1, 0xff}} {
		if _, _, err := DecodeHostFrame(frame); err == nil {
			t.Fatalf("accepted %v", frame)
		}
	}
	if _, err := EncodeHostFrame("", nil); err == nil {
		t.Fatal("accepted empty route")
	}
}
