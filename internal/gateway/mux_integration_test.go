package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// The installed SDK exercises the actual host-link messages against the Go
// multiplexer. The server is confined to localhost and has no cluster access.
func TestMuxWithPaseoSDK(t *testing.T) {
	if os.Getenv("PASEO_GATEWAY_E2E") != "1" {
		t.Skip("set PASEO_GATEWAY_E2E=1 to use the local Paseo SDK")
	}
	_, file, _, _ := runtime.Caller(0)
	plugin := filepath.Join(filepath.Dir(file), "..", "..", "plugin")
	if _, err := os.Stat(filepath.Join(plugin, "node_modules", "@getpaseo", "client")); err != nil {
		t.Skip("plugin dependencies are not installed")
	}
	p := fixture(t, true)
	server := websocket.Server{Handshake: func(*websocket.Config, *http.Request) error { return nil }, Handler: func(ws *websocket.Conn) {
		defer ws.Close()
		var first Frame
		if frameCodec.Receive(ws, &first) != nil || first.Binary {
			return
		}
		if _, err := AuthenticateHello(first.Data, "integration-secret"); err != nil {
			return
		}
		info, _ := sessionFrame(map[string]interface{}{"type": "status", "payload": map[string]interface{}{"status": "server_info", "protocolVersion": 1, "serverId": "test-gateway", "hostname": "test", "version": "0.16.2", "features": map[string]bool{"connectedHosts": true, "hostMultiplexing": true}}})
		if frameCodec.Send(ws, info) != nil {
			return
		}
		mux := Mux{Link: NewLink([]string{"workspace.read", "daemon.read"}), ServerID: "test-gateway", Hostname: "test", Version: "0.16.2", Dispatch: func(ctx context.Context, _ string, _ ScopedIdentity, input Frame) ([]Frame, error) {
			output, err := p.HandleDiscovery(ctx, input)
			return []Frame{output}, err
		}}
		defer mux.Link.Close()
		for {
			var frame Frame
			if frameCodec.Receive(ws, &frame) != nil {
				return
			}
			replies, err := mux.Handle(context.Background(), frame)
			if err != nil {
				return
			}
			for _, reply := range replies {
				if frameCodec.Send(ws, reply) != nil {
					return
				}
			}
		}
	}}
	srv := httptest.NewServer(server)
	defer srv.Close()
	script := `import {createHostClient} from '@getpaseo/client/node';
const client=createHostClient(process.argv[1],{clientId:'sdk-test',clientType:'cli',reconnect:{enabled:false},connectTimeoutMs:5000});
try {
  await client.connect();
  const route=await client.openHostLink('scope-1');
  const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('channel timeout')),5000); client.subscribeRawMessages(m=>{if(m.type==='hosts.route.frame' && m.payload.subscriptionId===route){clearTimeout(timer); resolve(JSON.parse(m.payload.data));}})});
  await client.sendHostFrame(route,JSON.stringify({type:'hello',clientId:'inner',clientType:'cli',protocolVersion:1,sessionPermissions:['workspace.read']}));
  const frame=await received;
  if(frame.message?.payload?.serverId!=='test-gateway') throw new Error('wrong gateway identity');
  const projects=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('project timeout')),5000); client.subscribeRawMessages(m=>{if(m.type==='hosts.route.frame' && m.payload.subscriptionId===route){const f=JSON.parse(m.payload.data); if(f.message?.type==='project.list.response'){clearTimeout(timer); resolve(f);}}})});
  await client.sendHostFrame(route,JSON.stringify({type:'session',message:{type:'project.list.request',requestId:'project-request'}}));
  const listing=await projects;
  if(listing.message.payload.projects[0]?.projectDisplayName!=='b') throw new Error('project discovery failed');
} finally { await client.close(); }
`
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script, "tcp://"+strings.TrimPrefix(srv.URL, "http://")+"?password=integration-secret")
	cmd.Dir = plugin
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Paseo SDK host-link test: %v: %s", err, output)
	}
}
