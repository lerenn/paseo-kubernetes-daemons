package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lerenn/paseo-kubernetes-daemons/internal/controller"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

func TestCreateEmitsPlugins(t *testing.T) {
	p := fixture(t, true)
	p.Plugins = []PluginEntry{{Source: "github:a/b", Ref: "v1.0.0", ConfigSecret: "pw-plugin-abc"}, {Source: "github:c/d"}}
	obj, err := p.Create(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	list, _, _ := unstructured.NestedSlice(obj.Object, "spec", "bootstrap", "plugins")
	if len(list) != 2 {
		t.Fatalf("plugins %v", list)
	}
	first := list[0].(map[string]interface{})
	if first["source"] != "github:a/b" || first["ref"] != "v1.0.0" || first["configSecretName"] != "pw-plugin-abc" {
		t.Fatalf("first %v", first)
	}
	if _, ok := list[1].(map[string]interface{})["configSecretName"]; ok {
		t.Fatal("empty config secret must be omitted")
	}
}

func TestPluginsCRDSkewGuard(t *testing.T) {
	prune := interceptor.Funcs{Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			unstructured.RemoveNestedField(u.Object, "spec", "bootstrap", "plugins")
		}
		return c.Create(ctx, obj, opts...)
	}}
	p := fixture(t, true)
	p.Client = interceptor.NewClient(p.Client.(client.WithWatch), prune)
	p.Plugins = []PluginEntry{{Source: "github:a/b"}}
	if _, err := p.Create(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "CRD out of date") {
		t.Fatalf("error %v", err)
	}
}

func TestCatalogValidatesPlugins(t *testing.T) {
	entries := []ProfileConfiguration{
		{Profile: "bad", Image: "i", Plugins: []PluginEntry{{Source: "--evil"}}},
		{Profile: "ok", Image: "i", Plugins: []PluginEntry{{Source: "github:a/b", Ref: "v1", ConfigSecret: "pw-plugin-x"}}},
	}
	data, _ := json.Marshal(entries)
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: CatalogName, Namespace: "ns", Labels: map[string]string{ownerLabel: "x"}}, Data: map[string]string{"projects.json": string(data)}}
	got, err := (Catalog{Client: fake.NewClientBuilder().WithObjects(cm).Build(), Namespace: "ns"}).Load(context.Background())
	if err != nil || len(got) != 1 || got[0].Profile != "ok" || len(got[0].Plugins) != 1 {
		t.Fatalf("got %+v err %v", got, err)
	}
	_ = controller.GVK
}
