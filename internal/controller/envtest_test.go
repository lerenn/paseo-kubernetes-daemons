package controller

import (
	"context"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"os"
	"path/filepath"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"testing"
	"time"
)

// Optional real API-server test. Unit tests still run without downloaded binaries.
func TestAPIAdmission(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("set KUBEBUILDER_ASSETS to run API-server admission test")
	}
	env := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd.yaml")}, ErrorIfCRDPathMissing: true}
	cfg, err := env.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := env.Stop(); err != nil {
			t.Error(err)
		}
	})
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "test"}}); err != nil {
		t.Fatal(err)
	}
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.Object["spec"] = map[string]interface{}{"image": "example/paseo:test"}
	if err := c.Create(ctx, w); err != nil {
		t.Fatal(err)
	}
	// Defaults must be available to the controller.
	if err := c.Get(ctx, client.ObjectKeyFromObject(w), w); err != nil {
		t.Fatal(err)
	}
	if w.Object["spec"].(map[string]interface{})["storage"] != "10Gi" {
		t.Fatal("storage default missing")
	}
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(w)}); err != nil {
		t.Fatal(err)
	}
	for _, child := range []client.Object{&corev1.Pod{}, &corev1.Service{}, &corev1.PersistentVolumeClaim{}} {
		if err := c.Get(ctx, client.ObjectKey{Name: "pw-demo", Namespace: "test"}, child); err != nil {
			t.Fatal(err)
		}
	}
	ephemeral := object()
	ephemeral.SetName("ephemeral")
	ephemeral.SetNamespace("test")
	ephemeral.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "ephemeral": true, "docker": map[string]interface{}{"enabled": true}, "workingDirectory": "/workspace/repository", "bootstrap": map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env"}}
	if err := c.Create(ctx, ephemeral); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(ephemeral)}); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(ctx, client.ObjectKey{Name: "pw-ephemeral", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	if len(pod.Spec.InitContainers) != 1 || pod.Spec.Volumes[0].EmptyDir == nil {
		t.Fatal("bootstrap/ephemeral spec was not preserved by API admission")
	}
	if len(pod.Spec.Containers) != 2 || pod.Spec.Containers[1].Name != "docker" {
		t.Fatal("Docker configuration was not preserved by API admission")
	}
	// New fields are admitted and preserved; incomplete or malformed ones are rejected.
	prov := map[string]interface{}{"secretName": "prov", "configMapName": "prov", "envSecretName": "prov-env", "envKeys": []interface{}{"OPENAI_API_KEY"}, "files": []interface{}{"auth.json"}, "mcps": []interface{}{"docs"}}
	res := map[string]interface{}{"requests": map[string]interface{}{"cpu": "500m", "memory": "1Gi", "ephemeral-storage": "2Gi"}, "limits": map[string]interface{}{"cpu": "4", "memory": "8Gi", "ephemeral-storage": "30Gi"}}
	shared := object()
	shared.SetName("shared")
	shared.SetNamespace("test")
	shared.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "docker": map[string]interface{}{"enabled": true, "resources": res, "dataSize": "40Gi"}, "bootstrap": map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env", "providers": prov}}
	if err := c.Create(ctx, shared); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(shared)}); err != nil {
		t.Fatal(err)
	}
	sharedPod := &corev1.Pod{}
	if err := c.Get(ctx, client.ObjectKey{Name: "pw-shared", Namespace: "test"}, sharedPod); err != nil {
		t.Fatal(err)
	}
	if len(sharedPod.Spec.InitContainers[0].Command) < 8 || sharedPod.Spec.Containers[1].Resources.Limits.Memory().String() != "8Gi" {
		t.Fatal("providers or docker settings were pruned by API admission")
	}
	bad := map[string]map[string]interface{}{
		"missing provider env secret": {"bootstrap": map[string]interface{}{"secretName": "p", "configMapName": "p", "envSecretName": "p-env", "providers": map[string]interface{}{"secretName": "a", "configMapName": "a"}}},
		"bad provider name":           {"bootstrap": map[string]interface{}{"secretName": "p", "configMapName": "p", "envSecretName": "p-env", "providers": map[string]interface{}{"secretName": "A_B", "configMapName": "a", "envSecretName": "a-env"}}},
		"bad env key":                 {"bootstrap": map[string]interface{}{"secretName": "p", "configMapName": "p", "envSecretName": "p-env", "providers": map[string]interface{}{"secretName": "a", "configMapName": "a", "envSecretName": "a-env", "envKeys": []interface{}{"bad-key"}}}},
		"unknown provider file":       {"bootstrap": map[string]interface{}{"secretName": "p", "configMapName": "p", "envSecretName": "p-env", "providers": map[string]interface{}{"secretName": "a", "configMapName": "a", "envSecretName": "a-env", "files": []interface{}{"config.toml"}}}},
		"providers without profile":   {"bootstrap": map[string]interface{}{"providers": prov}},
		"docker resources incomplete": {"docker": map[string]interface{}{"enabled": true, "resources": map[string]interface{}{"requests": map[string]interface{}{"cpu": "1"}, "limits": map[string]interface{}{"cpu": "2"}}}},
		"docker data size":            {"docker": map[string]interface{}{"enabled": true, "dataSize": "lots"}},
	}
	for name, spec := range bad {
		o := object()
		o.SetName("bad")
		o.SetNamespace("test")
		spec["image"] = "example/paseo:test"
		o.Object["spec"] = spec
		if err := c.Create(ctx, o); err == nil {
			t.Fatalf("%s was admitted", name)
		}
	}
	// Read the latest resourceVersion after the status update.
	if err := c.Get(ctx, client.ObjectKeyFromObject(w), w); err != nil {
		t.Fatal(err)
	}
	w.Object["spec"].(map[string]interface{})["image"] = "other"
	if err := c.Update(ctx, w); err == nil {
		t.Fatal("immutable spec was changed")
	}
}
