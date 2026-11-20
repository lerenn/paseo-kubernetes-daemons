package gateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

// Uses real isolated Paseo daemons in disposable containers. Kubernetes API
// writes use the same fake client as the unit tests; no cluster is accessed.
func TestGatewayTwoWorkspaceDaemons(t *testing.T) {
	if os.Getenv("PASEO_GATEWAY_CONTAINER_E2E") != "1" {
		t.Skip("set PASEO_GATEWAY_CONTAINER_E2E=1 and build paseo-gateway-workspace:test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	p := fixture(t, true)
	var mu sync.Mutex
	addresses := map[string]string{}
	run := func(args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%s failed: %w: %s", args[0], err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	wait := func(ctx context.Context, name string) (string, error) {
		directory, err := os.MkdirTemp("", "paseo-gateway-pod-")
		if err != nil {
			return "", err
		}
		t.Cleanup(func() { _ = os.RemoveAll(directory) })
		repo := filepath.Join(directory, "repository")
		if err := os.MkdirAll(repo, 0755); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(repo, "marker.txt"), []byte(name), 0644); err != nil {
			return "", err
		}
		for _, args := range [][]string{{"git", "-C", repo, "init", "-b", "main"}, {"git", "-C", repo, "add", "."}, {"git", "-C", repo, "-c", "user.name=Gateway Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"}, {"git", "-C", repo, "remote", "add", "origin", "https://example.com/a/b"}} {
			if _, err := run(args...); err != nil {
				return "", err
			}
		}
		container := "gateway-test-" + strings.TrimPrefix(randomID(), "gw_")
		alias := controller.GatewayRoot(name)
		containerID, err := run("docker", "run", "--detach", "--rm", "--name", container, "--cpus=1", "--memory=512m", "--publish", "127.0.0.1::6767", "--mount", "type=bind,source="+directory+",target=/workspace", "--mount", "type=bind,source="+directory+",target="+alias, "--env", "PASEO_HOME="+alias+"/.paseo", "--env", "PASEO_PASSWORD=integration-password", "--env", "PASEO_HOSTNAMES=127.0.0.1,localhost", "paseo-gateway-workspace:test")
		if err != nil {
			return "", err
		}
		t.Cleanup(func() { _ = exec.Command("docker", "rm", "--force", container).Run() })
		address, err := run("docker", "port", container, "6767/tcp")
		if err != nil {
			return "", err
		}
		endpoint := fmt.Sprintf("pw-%s.%s.svc:6767", name, p.Namespace)
		mu.Lock()
		addresses[endpoint] = address
		mu.Unlock()
		for {
			attempt, stop := context.WithTimeout(ctx, time.Second)
			backend, e := DialBackend(attempt, address, "probe", "integration-password")
			stop()
			if e == nil {
				backend.Close()
				break
			}
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := p.Client.Get(ctx, types.NamespacedName{Name: name, Namespace: p.Namespace}, obj); err != nil {
			return "", err
		}
		obj.Object["status"] = map[string]interface{}{"phase": "Ready", "podUID": containerID, "endpoint": endpoint}
		if err := p.Client.Update(ctx, obj); err != nil {
			return "", err
		}
		return endpoint, nil
	}
	dial := func(ctx context.Context, endpoint, id, password string, permissions []string, capabilities map[string]interface{}) (*Backend, error) {
		mu.Lock()
		address := addresses[endpoint]
		mu.Unlock()
		if address == "" {
			return nil, fmt.Errorf("no test daemon for %s", endpoint)
		}
		return DialScopedBackend(ctx, address, id, password, permissions, capabilities)
	}
	handler, err := NewHandler(ServerConfig{Context: ctx, ServerID: "integration-gateway", Hostname: "Test Kubernetes", Version: "0.16.2", Password: "integration-password", AllowedHosts: []string{"127.0.0.1"}, Permissions: []string{"daemon.read", "workspace.read", "workspace.write", "workspace.manage"}, OpenSession: func(ctx context.Context, identity ScopedIdentity, emit func(Frame) error) SessionSink {
		return NewSession(ctx, SessionOptions{ServerID: "integration-gateway", Hostname: "Test Kubernetes", Provisioner: p, Identity: identity, Emit: emit, BackendPassword: "integration-password", dialBackend: dial, waitReady: wait})
	}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	_, file, _, _ := runtime.Caller(0)
	plugin := filepath.Join(filepath.Dir(file), "..", "..", "plugin")
	script := `import assert from 'node:assert/strict';
import {createHostClient} from '@getpaseo/client/node';
const client=createHostClient(process.argv[1],{clientId:'two-workspace-test',clientType:'cli',reconnect:{enabled:false}});
try {
 await client.connect();
 const project=(await client.listProjects()).projects[0]; assert.ok(project);
 const create=key=>client.createWorkspace({idempotencyKey:key,source:{kind:'directory',path:project.projectRootPath,projectId:project.projectId}});
 const a=(await create('first')).workspace; assert.ok(a);
 const b=(await create('second')).workspace; assert.ok(b); assert.notEqual(a.id,b.id); assert.notEqual(a.workspaceDirectory,b.workspaceDirectory);
 const listing=await client.fetchWorkspaces(); assert.equal(listing.entries.length,2);
 const text=async w=>new TextDecoder().decode((await client.readFile(w.workspaceDirectory,'marker.txt')).bytes);
 const [ta,tb]=await Promise.all([text(a),text(b)]); assert.notEqual(ta,tb);
 const terminal=await client.createTerminal(a.workspaceDirectory,'Test',undefined,{workspaceId:a.id,command:'sh',args:['-c','printf GATEWAY_TERMINAL_A; exec sh']}); assert.equal(terminal.error,null); assert.ok(terminal.terminal);
 let found=false; for(let i=0;i<20;i++){const capture=await client.captureTerminal(terminal.terminal.id,{stripAnsi:true}); if(capture.lines.join('\n').includes('GATEWAY_TERMINAL_A')){found=true;break;} await new Promise(r=>setTimeout(r,100));} assert.ok(found,'terminal routed correctly');
 const onlyB=await client.listTerminals(b.workspaceDirectory,undefined,{workspaceId:b.id}); assert.equal(onlyB.terminals.length,0);
 await client.killTerminal(terminal.terminal.id);
 console.log('Two workspaces, isolated files, directory aggregation, terminal routing passed.');
} finally { await client.close(); }
`
	command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script, "tcp://"+strings.TrimPrefix(server.URL, "http://")+"?password=integration-password")
	command.Dir = plugin
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("gateway integration: %v: %s", err, out)
	}
	t.Log(strings.TrimSpace(string(out)))
}
