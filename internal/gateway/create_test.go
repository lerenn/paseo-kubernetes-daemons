package gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

type fakeWorkspaceBackend struct {
	sent   []byte
	frames []Frame
	closed bool
}

func (b *fakeWorkspaceBackend) SendText(frame []byte) error {
	b.sent = append([]byte(nil), frame...)
	return nil
}
func (b *fakeWorkspaceBackend) Receive() (Frame, error) {
	if len(b.frames) == 0 {
		return Frame{}, errors.New("no frames")
	}
	f := b.frames[0]
	b.frames = b.frames[1:]
	return f, nil
}
func (b *fakeWorkspaceBackend) Close() error { b.closed = true; return nil }

func TestCreatorProvisionsAndForwardsOnce(t *testing.T) {
	ctx := context.Background()
	p := fixture(t, true)
	d, err := p.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	backend := &fakeWorkspaceBackend{frames: []Frame{
		{Data: []byte(`{"type":"session","message":{"type":"workspace.create.update","payload":{"phase":"accepted"}}}`)},
		{Data: []byte(`{"type":"session","message":{"type":"workspace.create.response","payload":{"requestId":"r1","error":null,"workspace":{"id":"w1","projectId":"pod-project","projectRootPath":"/workspace/repository","workspaceDirectory":"/workspace/repository"},"agent":{"id":"a1","workspaceId":"w1","cwd":"/workspace/repository"}}}}`)},
	}}
	creator := Creator{Provisioner: p, ClientID: "client", Dial: func(context.Context, string, string, string) (WorkspaceBackend, error) { return backend, nil }, Wait: func(ctx context.Context, name string) (string, error) {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: name}, obj); err != nil {
			return "", err
		}
		obj.Object["status"] = map[string]interface{}{"phase": "Ready", "podUID": "pod"}
		if err := p.Client.Update(ctx, obj); err != nil {
			return "", err
		}
		return fmt.Sprintf("pw-%s.%s.svc:6767", name, p.Namespace), nil
	}}
	input := Frame{Data: []byte(fmt.Sprintf(`{"type":"session","message":{"type":"workspace.create.request","requestId":"r1","idempotencyKey":"intent","source":{"kind":"directory","projectId":%q,"path":%q},"agent":{"config":{"provider":"codex","cwd":%q},"initialPrompt":"hello"}}}`, d.Project.ID, d.Project.Root, d.Project.Root))}
	result, err := creator.Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Backend == nil || backend.closed || len(result.Events) != 1 || !strings.Contains(string(backend.sent), `"cwd":"/workspace/repository"`) || !strings.Contains(string(result.Response.Data), "/__paseo_kubernetes/") {
		t.Fatalf("bad creation result %+v", result)
	}
	if endpoint, err := p.Resolve(ctx, "agent", "a1"); err != nil || !strings.Contains(endpoint, result.Environment) {
		t.Fatalf("agent route %s %v", endpoint, err)
	}
}

func TestCreatorRejectsUnknownProviderBeforeDial(t *testing.T) {
	ctx := context.Background()
	p := fixture(t, true)
	d, _ := p.Discover(ctx)
	dialled := false
	c := Creator{Provisioner: p, ClientID: "client", Dial: func(context.Context, string, string, string) (WorkspaceBackend, error) {
		dialled = true
		return nil, errors.New("unexpected")
	}}
	input := Frame{Data: []byte(fmt.Sprintf(`{"type":"session","message":{"type":"workspace.create.request","requestId":"r1","source":{"kind":"directory","projectId":%q,"path":%q},"agent":{"config":{"provider":"claude","cwd":%q}}}}`, d.Project.ID, d.Project.Root, d.Project.Root))}
	if _, err := c.Create(ctx, input); err == nil || dialled {
		t.Fatal("unsynced provider was accepted")
	}
}

func TestCreatorDoesNotReplayAfterPodReplacement(t *testing.T) {
	ctx := context.Background()
	p := fixture(t, true)
	name := ready(t, p, "intent", "pod-a")
	c := Creator{Provisioner: p}
	if err := c.claimPod(ctx, name, "pod-a"); err != nil {
		t.Fatal(err)
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
	if err := c.claimPod(ctx, name, "pod-b"); err == nil || !strings.Contains(err.Error(), "outcome is unknown") {
		t.Fatalf("unsafe replay: %v", err)
	}
}
