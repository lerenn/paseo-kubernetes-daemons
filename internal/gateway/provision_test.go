package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func fixture(t *testing.T, complete bool) *Provisioner {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	scheme.AddKnownTypeWithName(controller.GVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"), &unstructured.UnstructuredList{})
	immutable := true
	meta := metav1.ObjectMeta{Name: "profile", Namespace: "workspaces", Labels: map[string]string{"workspaces.paseo.sh/profile-owner": "owner"}}
	objects := []client.Object{&corev1.Secret{ObjectMeta: meta, Immutable: &immutable, Data: map[string][]byte{"files.json": []byte(`{"config.toml":"", "auth.json":"{\"tokens\":{\"access_token\":\"example\"}}"}`)}}}
	if complete {
		envmeta := meta.DeepCopy()
		envmeta.Name = "profile-env"
		objects = append(objects, &corev1.Secret{ObjectMeta: *envmeta, Immutable: &immutable}, &corev1.ConfigMap{ObjectMeta: meta, Immutable: &immutable, Data: map[string]string{"bootstrap.json": `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true,"providers":["codex-login"],"mcps":["docs"]}`}})
	}
	return &Provisioner{Client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build(), Namespace: "workspaces", Image: "workspace:v1", Profile: "profile"}
}

func TestRequirementsAreCheckedBeforeCreating(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	for _, tc := range []Requirements{{Provider: "claude"}, {Repository: "https://example.com/other"}, {MCPs: []string{"unavailable"}}} {
		if _, err := p.CreateWithRequirements(ctx, "request", tc); err == nil {
			t.Fatalf("accepted unsynced requirements: %+v", tc)
		}
	}
	valid := Requirements{Provider: "codex", Repository: "https://example.com/a/b", MCPs: []string{"docs"}}
	if _, err := p.CreateWithRequirements(ctx, "request", valid); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CreateWithRequirements(ctx, "request", Requirements{Provider: "codex"}); err == nil {
		t.Fatal("different requirements must conflict on retry")
	}
}

func TestWaitReady(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	obj, err := p.Create(ctx, "ready-request")
	if err != nil {
		t.Fatal(err)
	}
	obj.Object["status"] = map[string]interface{}{"phase": "Ready", "endpoint": "pw.example:6767"}
	if err := p.Client.Update(ctx, obj); err != nil {
		t.Fatal(err)
	}
	endpoint, err := p.WaitReady(ctx, obj.GetName(), time.Millisecond)
	if err != nil || endpoint != "pw.example:6767" {
		t.Fatalf("endpoint %q, error %v", endpoint, err)
	}
	obj.Object["status"] = map[string]interface{}{"phase": "Failed", "message": "ImagePullBackOff"}
	if err := p.Client.Update(ctx, obj); err != nil {
		t.Fatal(err)
	}
	if _, err := p.WaitReady(ctx, obj.GetName(), time.Millisecond); err == nil || !strings.Contains(err.Error(), "ImagePullBackOff") {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestCreateIdempotent(t *testing.T) {
	p := fixture(t, true)
	ctx := context.Background()
	a, err := p.Create(ctx, "request-1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.Create(ctx, "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if a.GetName() != b.GetName() {
		t.Fatal("retry created a different environment")
	}
	if dir, _, _ := unstructured.NestedString(a.Object, "spec", "workingDirectory"); dir != "/workspace/repository" {
		t.Fatalf("working directory %q", dir)
	}
	c, err := p.Create(ctx, "request-2")
	if err != nil {
		t.Fatal(err)
	}
	if c.GetName() == a.GetName() {
		t.Fatal("distinct requests collided")
	}
	p.Docker = true
	if _, err := p.Create(ctx, "request-1"); err == nil {
		t.Fatal("changed configuration should conflict")
	}
}

func TestMissingProfileDoesNotCreateWorkspace(t *testing.T) {
	p := fixture(t, false)
	ctx := context.Background()
	if _, err := p.Create(ctx, "request"); err == nil {
		t.Fatal("missing profile should fail")
	}
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"))
	if err := p.Client.List(ctx, list, client.InNamespace(p.Namespace)); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 0 {
		t.Fatal("created workspace without complete profile")
	}
}

func TestCatalogDefaultsMissingImage(t *testing.T) {
	entries := []ProfileConfiguration{{Profile: "p"}}
	data, _ := json.Marshal(entries)
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: CatalogName, Namespace: "ns", Labels: map[string]string{"workspaces.paseo.sh/profile-owner": "x"}}, Data: map[string]string{"projects.json": string(data)}}
	c := fake.NewClientBuilder().WithObjects(cm).Build()
	if _, err := (Catalog{Client: c, Namespace: "ns"}).Load(context.Background()); err == nil {
		t.Fatal("missing image without default must fail")
	}
	got, err := (Catalog{Client: c, Namespace: "ns", DefaultImage: "img:1"}).Load(context.Background())
	if err != nil || len(got) != 1 || got[0].Image != "img:1" {
		t.Fatalf("got %+v err %v", got, err)
	}
}
