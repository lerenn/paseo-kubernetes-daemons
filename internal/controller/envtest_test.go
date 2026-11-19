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
	// Read the latest resourceVersion after the status update.
	if err := c.Get(ctx, client.ObjectKeyFromObject(w), w); err != nil {
		t.Fatal(err)
	}
	w.Object["spec"].(map[string]interface{})["image"] = "other"
	if err := c.Update(ctx, w); err == nil {
		t.Fatal("immutable spec was changed")
	}
}
