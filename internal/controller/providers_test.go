package controller

import (
	"context"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"slices"
	"testing"
)

func reconcileSpec(t *testing.T, spec map[string]interface{}) (*corev1.Pod, error) {
	t.Helper()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("uid")
	w.Object["spec"] = spec
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, &corev1.Pod{}).WithObjects(w).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(w)}); err != nil {
		return nil, err
	}
	pod := &corev1.Pod{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "pw-demo", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	return pod, nil
}

func bootstrapSpec(providers map[string]interface{}) map[string]interface{} {
	b := map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env"}
	if providers != nil {
		b["providers"] = providers
	}
	return map[string]interface{}{"image": "test", "storage": "4Gi", "ephemeral": true, "bootstrap": b}
}

func TestLegacyBootstrapUnchangedWithoutProviders(t *testing.T) {
	pod, err := reconcileSpec(t, bootstrapSpec(nil))
	if err != nil {
		t.Fatal(err)
	}
	init := pod.Spec.InitContainers[0]
	want := []string{"python3", "/usr/local/lib/paseo-daemon/bootstrap.py", "--profile", "profile"}
	if !slices.Equal(init.Command, want) || len(init.VolumeMounts) != 3 || len(pod.Spec.Volumes) != 3 {
		t.Fatalf("legacy path changed: %v %v", init.Command, pod.Spec.Volumes)
	}
	if len(pod.Spec.Containers[0].Env) != 4 || len(pod.Spec.Containers[0].EnvFrom) != 1 {
		t.Fatal("legacy env changed")
	}
}

func TestProvidersSubsetOnly(t *testing.T) {
	pod, err := reconcileSpec(t, bootstrapSpec(map[string]interface{}{
		"secretName": "prov", "configMapName": "prov", "envSecretName": "prov-env",
		"envKeys": []interface{}{"OPENAI_API_KEY", "GITHUB_TOKEN"}, "files": []interface{}{"auth.json"}, "mcps": []interface{}{"docs", "web"}}))
	if err != nil {
		t.Fatal(err)
	}
	daemon, init := pod.Spec.Containers[0], pod.Spec.InitContainers[0]
	// Only the project env Secret is envFrom; the provider env Secret is never bulk-imported.
	for _, c := range []corev1.Container{daemon, init} {
		if len(c.EnvFrom) != 1 || c.EnvFrom[0].SecretRef.Name != "profile-env" {
			t.Fatalf("%s: unexpected envFrom %v", c.Name, c.EnvFrom)
		}
		keys := []string{}
		for _, e := range c.Env {
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				if e.ValueFrom.SecretKeyRef.Name != "prov-env" || e.ValueFrom.SecretKeyRef.Key != e.Name {
					t.Fatalf("bad ref %v", e)
				}
				keys = append(keys, e.Name)
			}
		}
		if !slices.Equal(keys, []string{"OPENAI_API_KEY", "GITHUB_TOKEN"}) {
			t.Fatalf("%s: env keys %v", c.Name, keys)
		}
	}
	// Provider volumes are mounted read-only in the init container only.
	if len(daemon.VolumeMounts) != 1 {
		t.Fatal("daemon must not mount provider files")
	}
	mounts := map[string]string{}
	for _, m := range init.VolumeMounts {
		if !m.ReadOnly && m.Name != "workspace" {
			t.Fatalf("writable mount %s", m.Name)
		}
		mounts[m.Name] = m.MountPath
	}
	if mounts["provider-credentials"] != "/var/run/paseo/providers/credentials" || mounts["provider-config"] != "/var/run/paseo/providers/config" {
		t.Fatalf("mounts %v", mounts)
	}
	vols := map[string]corev1.Volume{}
	for _, v := range pod.Spec.Volumes {
		vols[v.Name] = v
	}
	if vols["provider-credentials"].Secret.SecretName != "prov" || vols["provider-config"].ConfigMap.Name != "prov" || *vols["provider-credentials"].Secret.DefaultMode != 0440 {
		t.Fatal("provider volumes wrong")
	}
	want := []string{"python3", "/usr/local/lib/paseo-daemon/bootstrap.py", "--profile", "profile",
		"--providers", "prov", "--providers-secrets", "/var/run/paseo/providers/credentials", "--providers-config", "/var/run/paseo/providers/config",
		"--provider-files=auth.json", "--provider-mcps=docs,web", "--provider-profiles="}
	if !slices.Equal(init.Command, want) {
		t.Fatalf("command %v", init.Command)
	}
}

func TestProvidersEmptySubsetIsNone(t *testing.T) {
	pod, err := reconcileSpec(t, bootstrapSpec(map[string]interface{}{"secretName": "prov", "configMapName": "prov", "envSecretName": "prov-env"}))
	if err != nil {
		t.Fatal(err)
	}
	cmd := pod.Spec.InitContainers[0].Command
	if !slices.Contains(cmd, "--provider-files=") || !slices.Contains(cmd, "--provider-mcps=") || len(pod.Spec.Containers[0].Env) != 4 {
		t.Fatalf("empty subset must mean none: %v", cmd)
	}
}

func TestProvidersMissingReferenceRejected(t *testing.T) {
	for _, missing := range []string{"secretName", "configMapName", "envSecretName"} {
		p := map[string]interface{}{"secretName": "prov", "configMapName": "prov", "envSecretName": "prov-env"}
		p[missing] = ""
		if _, err := reconcileSpec(t, bootstrapSpec(p)); err == nil {
			t.Fatalf("accepted empty %s", missing)
		}
	}
}

func TestDockerSidecarSettings(t *testing.T) {
	res := map[string]interface{}{
		"requests": map[string]interface{}{"cpu": "500m", "memory": "1Gi", "ephemeral-storage": "2Gi"},
		"limits":   map[string]interface{}{"cpu": "4", "memory": "8Gi", "ephemeral-storage": "30Gi"}}
	pod, err := reconcileSpec(t, map[string]interface{}{"image": "test", "storage": "4Gi", "docker": map[string]interface{}{"enabled": true, "resources": res, "dataSize": "40Gi"}})
	if err != nil {
		t.Fatal(err)
	}
	d := pod.Spec.Containers[1]
	if d.Resources.Limits.Cpu().String() != "4" || d.Resources.Limits.Memory().String() != "8Gi" || d.Resources.Requests.Cpu().String() != "500m" || d.Resources.Limits.StorageEphemeral().String() != "30Gi" {
		t.Fatalf("resources %v", d.Resources)
	}
	for _, v := range pod.Spec.Volumes {
		if v.Name == "docker-data" && v.EmptyDir.SizeLimit.String() != "40Gi" {
			t.Fatalf("data size %s", v.EmptyDir.SizeLimit)
		}
	}
	// Without the fields the sidecar keeps today's values.
	pod, err = reconcileSpec(t, map[string]interface{}{"image": "test", "storage": "4Gi", "docker": map[string]interface{}{"enabled": true}})
	if err != nil {
		t.Fatal(err)
	}
	d = pod.Spec.Containers[1]
	if d.Resources.Limits.Memory().String() != "2Gi" || d.Resources.Limits.StorageEphemeral().String() != "12Gi" {
		t.Fatalf("defaults changed %v", d.Resources)
	}
	for _, v := range pod.Spec.Volumes {
		if v.Name == "docker-data" && v.EmptyDir.SizeLimit.String() != "10Gi" {
			t.Fatal("default data size changed")
		}
	}
}
