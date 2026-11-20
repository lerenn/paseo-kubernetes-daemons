package gateway

import (
	"context"
	"strings"
	"testing"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func ready(t *testing.T, p *Provisioner, key, pod string) string {
	t.Helper()
	ctx := context.Background()
	obj, err := p.Create(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	obj.Object["status"] = map[string]interface{}{"phase": "Ready", "podUID": pod}
	if err := p.Client.Update(ctx, obj); err != nil {
		t.Fatal(err)
	}
	return obj.GetName()
}

func TestRoutesSurviveRestartAndRejectPodReplacement(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	name := ready(t, p, "first", "pod-a")
	if err := p.SaveRoutes(ctx, name, Routes{PodUID: "pod-a", Workspace: "wks-1", Agents: []string{"agent-1"}}); err != nil {
		t.Fatal(err)
	}
	if err := p.SaveRoutes(ctx, name, Routes{PodUID: "pod-a", Workspace: "wks-1", Terminals: []string{"terminal-1"}}); err != nil {
		t.Fatal(err)
	}
	// A fresh provisioner represents a gateway restart.
	restarted := *p
	for kind, id := range map[string]string{"workspace": "wks-1", "agent": "agent-1", "terminal": "terminal-1"} {
		endpoint, err := restarted.Resolve(ctx, kind, id)
		if err != nil || endpoint != "pw-"+name+".workspaces.svc:6767" {
			t.Fatalf("%s: %s %v", kind, endpoint, err)
		}
	}
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(controller.GVK)
	if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: name}, obj); err != nil {
		t.Fatal(err)
	}
	obj.Object["status"] = map[string]interface{}{"phase": "Ready", "podUID": "pod-b"}
	if err := p.Client.Update(ctx, obj); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Resolve(ctx, "agent", "agent-1"); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("stale route accepted: %v", err)
	}
	if err := p.SaveRoutes(ctx, name, Routes{PodUID: "pod-b", Workspace: "wks-2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Resolve(ctx, "agent", "agent-1"); err == nil {
		t.Fatal("old agent survived pod replacement")
	}
}

func TestRoutesFailClosedForDuplicateIdentity(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	for _, key := range []string{"a", "b"} {
		name := ready(t, p, key, key)
		if err := p.SaveRoutes(ctx, name, Routes{PodUID: key, Workspace: "workspace-" + key, Agents: []string{"duplicate"}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.Resolve(ctx, "agent", "duplicate"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous route accepted: %v", err)
	}
}

func TestSelectBackendRequiresConsistentKnownRoutes(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	a := ready(t, p, "a", "a")
	b := ready(t, p, "b", "b")
	if err := p.SaveRoutes(ctx, a, Routes{PodUID: "a", Workspace: "w1", Agents: []string{"a1"}, Terminals: []string{"t1"}}); err != nil {
		t.Fatal(err)
	}
	if err := p.SaveRoutes(ctx, b, Routes{PodUID: "b", Workspace: "w2", Agents: []string{"a2"}}); err != nil {
		t.Fatal(err)
	}
	for _, frame := range []string{
		`{"type":"session","message":{"type":"agent.create.request","workspaceId":"w1","agentId":"new-agent"}}`,
		`{"type":"session","message":{"type":"terminal_input","terminalId":"t1","message":{"type":"input","data":"hello"}}}`,
		`{"type":"session","message":{"type":"create_terminal_request","workspaceId":"w1","agentId":"a1"}}`,
	} {
		endpoint, err := p.SelectBackend(ctx, []byte(frame))
		if err != nil || endpoint != "pw-"+a+".workspaces.svc:6767" {
			t.Fatalf("%s: %q %v", frame, endpoint, err)
		}
	}
	for _, frame := range []string{
		`{"type":"session","message":{"type":"create_terminal_request","workspaceId":"w1","agentId":"a2"}}`,
		`{"type":"session","message":{"type":"workspace.create.request","workspaceId":"w1"}}`,
		`{"type":"session","message":{"type":"send_agent_message","agentId":"unknown"}}`,
	} {
		if _, err := p.SelectBackend(ctx, []byte(frame)); err == nil {
			t.Fatalf("accepted unsafe request: %s", frame)
		}
	}
}

func TestPathRequestRewritesOnlyCWDAndChecksIdentities(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	name := ready(t, p, "path", "pod")
	if err := p.SaveRoutes(ctx, name, Routes{PodUID: "pod", Workspace: "w1", Agents: []string{"a1"}}); err != nil {
		t.Fatal(err)
	}
	virtual, err := VirtualizePath(name, "/workspace/repository")
	if err != nil {
		t.Fatal(err)
	}
	frame := []byte(`{"type":"session","message":{"type":"fs.file.write.request","cwd":"` + virtual + `","path":"x.txt","content":"` + virtual + `"}}`)
	endpoint, out, err := p.RoutePathRequest(ctx, frame)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "pw-"+name+".workspaces.svc:6767" || !strings.Contains(string(out), `"cwd":"/workspace/repository"`) || !strings.Contains(string(out), `"content":"`+virtual+`"`) {
		t.Fatalf("wrong translation %s %s", endpoint, out)
	}
	bad := []byte(`{"type":"session","message":{"type":"create_terminal_request","cwd":"` + virtual + `","agentId":"unknown"}}`)
	if _, _, err := p.RoutePathRequest(ctx, bad); err == nil {
		t.Fatal("unknown agent was accepted")
	}
}
