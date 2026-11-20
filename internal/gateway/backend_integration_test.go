package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Opt in because this starts a real Paseo daemon, in an empty temporary home.
func TestBackendWithPaseoDaemon(t *testing.T) {
	if os.Getenv("PASEO_GATEWAY_E2E") != "1" {
		t.Skip("set PASEO_GATEWAY_E2E=1 to run against a real local daemon")
	}
	binary, err := exec.LookPath("paseo")
	if err != nil {
		t.Skip("paseo is not installed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := listener.Addr().String()
	_ = listener.Close()
	home := t.TempDir()
	daemonHome := filepath.Join(home, "daemon")
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "daemon", "run", "--home", daemonHome)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "PASEO_HOME=" + daemonHome, "PASEO_LISTEN=" + endpoint, "PASEO_RELAY_ENABLED=false"}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()
	var backend *Backend
	for ctx.Err() == nil {
		attempt, stop := context.WithTimeout(ctx, time.Second)
		backend, err = DialBackend(attempt, endpoint, "gateway-integration-test", "")
		stop()
		if err == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(fmt.Errorf("connect isolated daemon: %w", err))
	}
	defer backend.Close()
	if backend.ServerID == "" {
		t.Fatal("daemon identity missing")
	}
	if err := backend.SendText([]byte(`{"type":"session","message":{"type":"fetch_workspaces_request","requestId":"integration-1"}}`)); err != nil {
		t.Fatal(err)
	}
	_ = backend.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		frame, err := backend.Receive()
		if err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Type    string `json:"type"`
			Message struct {
				Type    string `json:"type"`
				Payload struct {
					RequestID string `json:"requestId"`
				} `json:"payload"`
			} `json:"message"`
		}
		if frame.Binary {
			continue
		}
		if err := json.Unmarshal(frame.Data, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Type == "session" && msg.Message.Type == "fetch_workspaces_response" && msg.Message.Payload.RequestID == "integration-1" {
			break
		}
	}
}
