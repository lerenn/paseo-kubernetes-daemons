package controller

import (
	"context"
	"errors"
	"fmt"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"slices"
	"strings"
	"testing"
)

func TestReconcile(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("workspace-uid")
	w.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "storage": "10Gi", "resources": map[string]interface{}{"limits": map[string]interface{}{"cpu": "2", "memory": "4Gi"}}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, &corev1.Pod{}).WithObjects(w).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: "demo", Namespace: "test"}}
	for i := 0; i < 2; i++ {
		if _, err := r.Reconcile(ctx, req); err != nil {
			t.Fatal(err)
		}
	}
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods); err != nil {
		t.Fatal(err)
	}
	if len(pods.Items) != 1 {
		t.Fatalf("got %d pods", len(pods.Items))
	}
	pod := &pods.Items[0]
	if !metav1.IsControlledBy(pod, w) {
		t.Fatal("missing owner")
	}
	if *pod.Spec.AutomountServiceAccountToken {
		t.Fatal("workspace has cluster credentials")
	}
	if pod.Spec.Containers[0].Resources.Limits.Cpu().String() != "2" {
		t.Fatal("CPU limit missing")
	}
	if pod.Spec.Volumes[0].PersistentVolumeClaim.ClaimName != "pw-demo" {
		t.Fatal("storage missing")
	}
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	if err := c.Status().Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	got := object()
	if err := c.Get(ctx, req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	status := got.Object["status"].(map[string]interface{})
	if status["phase"] != "Ready" || status["endpoint"] != "pw-demo.test.svc:6767" {
		t.Fatalf("wrong status: %v", status)
	}
	pod.Status.Conditions = nil
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "daemon", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff"}}}}
	if err := c.Status().Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	status = got.Object["status"].(map[string]interface{})
	if status["phase"] != "Failed" || status["message"] != "ImagePullBackOff" {
		t.Fatalf("wrong failure status: %v", status)
	}
	// A replacement pod is rebuilt from the same CR, retaining the same PVC.
	if err := c.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, types.NamespacedName{Name: "pw-demo", Namespace: "test"}, &corev1.Pod{}); err != nil {
		t.Fatal(err)
	}
}
func TestRefuseForeignResource(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("uid")
	w.Object["spec"] = map[string]interface{}{"image": "test", "storage": "1Gi"}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "pw-demo", Namespace: "test"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w).WithObjects(w, pvc).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: "demo", Namespace: "test"}}); err == nil {
		t.Fatal("adopted foreign resource")
	}
}

func TestGatewayMountsAreSharedWithDocker(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("gateway")
	w.SetNamespace("test")
	w.SetUID("uid")
	w.Object["spec"] = map[string]interface{}{"image": "test", "storage": "4Gi", "gateway": true, "ephemeral": true, "workingDirectory": "/workspace/repository", "docker": map[string]interface{}{"enabled": true}, "bootstrap": map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w).WithObjects(w).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: types.NamespacedName{Name: "gateway", Namespace: "test"}}); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(ctx, types.NamespacedName{Name: "pw-gateway", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	root := GatewayRoot("gateway")
	if pod.Spec.Containers[0].WorkingDir != root+"/repository" {
		t.Fatal("daemon cwd does not use the routable mount")
	}
	for _, container := range append(pod.Spec.Containers, pod.Spec.InitContainers...) {
		found := false
		for _, mount := range container.VolumeMounts {
			if mount.Name == "workspace" && mount.MountPath == root {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s has no shared gateway mount", container.Name)
		}
	}
	if !slices.Contains(pod.Spec.InitContainers[0].Command, root) {
		t.Fatal("bootstrap does not trust the actual project path")
	}
}

func TestEphemeralBootstrap(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("uid")
	w.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "storage": "4Gi", "ephemeral": true, "workingDirectory": "/workspace/repository", "bootstrap": map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, &corev1.Pod{}).WithObjects(w).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: types.NamespacedName{Name: "demo", Namespace: "test"}}); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(ctx, types.NamespacedName{Name: "pw-demo", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	if pod.Spec.Volumes[0].EmptyDir == nil {
		t.Fatal("expected ephemeral workspace")
	}
	pvcs := &corev1.PersistentVolumeClaimList{}
	if err := c.List(ctx, pvcs); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatal("ephemeral workspace allocated a PVC")
	}
	if len(pod.Spec.InitContainers) != 1 || pod.Spec.InitContainers[0].Name != "bootstrap" {
		t.Fatal("missing bootstrap init container")
	}
	init := pod.Spec.InitContainers[0]
	if len(init.VolumeMounts) != 3 || !init.VolumeMounts[1].ReadOnly || !init.VolumeMounts[2].ReadOnly {
		t.Fatal("snapshot mounts must be read only")
	}
	if len(pod.Spec.Containers[0].VolumeMounts) != 1 {
		t.Fatal("raw snapshot files must only be mounted into init container")
	}
	if pod.Spec.Containers[0].WorkingDir != "/workspace/repository" {
		t.Fatal("wrong workspace directory")
	}
	if pod.Spec.Containers[0].EnvFrom[0].SecretRef.Name != "profile-env" {
		t.Fatal("missing selected environment credentials")
	}
	if *pod.Spec.AutomountServiceAccountToken {
		t.Fatal("workspace received API credentials")
	}
}

func TestDockerSidecar(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			scheme := runtime.NewScheme()
			_ = corev1.AddToScheme(scheme)
			w := object()
			w.SetName("docker")
			w.SetNamespace("test")
			w.SetUID("uid")
			w.Object["spec"] = map[string]interface{}{"image": "test", "storage": "4Gi", "ephemeral": true, "docker": map[string]interface{}{"enabled": enabled}}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w).WithObjects(w).Build()
			r := &Reconciler{Client: c, Namespace: "test"}
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: "docker", Namespace: "test"}}); err != nil {
				t.Fatal(err)
			}
			pod := &corev1.Pod{}
			if err := c.Get(context.Background(), types.NamespacedName{Name: "pw-docker", Namespace: "test"}, pod); err != nil {
				t.Fatal(err)
			}
			if !enabled {
				if len(pod.Spec.Containers) != 1 {
					t.Fatal("Docker enabled by default")
				}
				return
			}
			if len(pod.Spec.Containers) != 2 {
				t.Fatal("missing sidecar")
			}
			daemon, docker := pod.Spec.Containers[0], pod.Spec.Containers[1]
			if !*docker.SecurityContext.Privileged || *docker.SecurityContext.RunAsUser != 0 || *docker.SecurityContext.RunAsNonRoot {
				t.Fatal("incorrect DinD security context")
			}
			if *pod.Spec.SecurityContext.RunAsUser != 1000 || *daemon.SecurityContext.AllowPrivilegeEscalation {
				t.Fatal("workspace privileges changed")
			}
			if !slices.Contains(docker.Args, "--group=1000") || !slices.Contains(daemon.Env, corev1.EnvVar{Name: "DOCKER_HOST", Value: "unix:///var/run/docker/docker.sock"}) {
				t.Fatal("socket access missing")
			}
			if docker.ReadinessProbe == nil || len(docker.Resources.Limits) != 3 {
				t.Fatal("missing readiness or resource limits")
			}
			for _, container := range []corev1.Container{daemon, docker} {
				if !slices.Contains(container.VolumeMounts, corev1.VolumeMount{Name: "workspace", MountPath: "/workspace"}) || !slices.Contains(container.VolumeMounts, corev1.VolumeMount{Name: "docker-socket", MountPath: "/var/run/docker"}) {
					t.Fatal("shared paths missing")
				}
			}
			for _, volume := range pod.Spec.Volumes {
				if volume.HostPath != nil {
					t.Fatal("host filesystem exposed")
				}
				if volume.Name == "docker-data" && (volume.EmptyDir == nil || volume.EmptyDir.SizeLimit.String() != "10Gi") {
					t.Fatal("Docker storage must be bounded and ephemeral")
				}
			}
		})
	}
}

func TestDockerSidecarConfiguration(t *testing.T) {
	r := &Reconciler{DockerMTU: 1450, DockerRegistryMirrors: []string{"https://m1.example", "https://m2.example"}}
	args := r.dockerdArgs()
	for _, want := range []string{"--feature=containerd-snapshotter=false", "--mtu=1450", "--default-network-opt=bridge=com.docker.network.driver.mtu=1450", "--registry-mirror=https://m1.example", "--registry-mirror=https://m2.example"} {
		if !slices.Contains(args, want) {
			t.Fatalf("missing %s in %v", want, args)
		}
	}
	for _, arg := range (&Reconciler{}).dockerdArgs() {
		if strings.HasPrefix(arg, "--mtu") || strings.HasPrefix(arg, "--registry-mirror") {
			t.Fatalf("unexpected %s by default", arg)
		}
	}
}

func TestDockerSidecarImage(t *testing.T) {
	for image, want := range map[string]string{"": DefaultDockerImage, "docker.io/library/docker:1-dind@sha256:abc": "docker.io/library/docker:1-dind@sha256:abc"} {
		scheme := runtime.NewScheme()
		_ = corev1.AddToScheme(scheme)
		w := object()
		w.SetName("img")
		w.SetNamespace("test")
		w.SetUID("uid")
		w.Object["spec"] = map[string]interface{}{"image": "test", "storage": "4Gi", "ephemeral": true, "docker": map[string]interface{}{"enabled": true}}
		c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w).WithObjects(w).Build()
		r := &Reconciler{Client: c, Namespace: "test", DockerImage: image}
		if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: "img", Namespace: "test"}}); err != nil {
			t.Fatal(err)
		}
		pod := &corev1.Pod{}
		if err := c.Get(context.Background(), types.NamespacedName{Name: "pw-img", Namespace: "test"}, pod); err != nil {
			t.Fatal(err)
		}
		if got := pod.Spec.Containers[1]; got.Name != "docker" || got.Image != want {
			t.Fatalf("got %s %s, want docker %s", got.Name, got.Image, want)
		}
	}
}

func pendingFixture(t *testing.T, funcs interceptor.Funcs) (*Reconciler, client.Client, ctrl.Request) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("workspace-uid")
	w.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "storage": "10Gi", "resources": map[string]interface{}{}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, &corev1.Pod{}).WithObjects(w).WithInterceptorFuncs(funcs).Build()
	return &Reconciler{Client: c, Namespace: "test"}, c, ctrl.Request{NamespacedName: types.NamespacedName{Name: "demo", Namespace: "test"}}
}

func workspaceStatus(t *testing.T, c client.Client, req ctrl.Request) map[string]interface{} {
	got := object()
	if err := c.Get(context.Background(), req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	status, _ := got.Object["status"].(map[string]interface{})
	return status
}

func TestPendingReasons(t *testing.T) {
	ctx := context.Background()
	r, c, req := pendingFixture(t, interceptor.Funcs{})
	for i := 0; i < 2; i++ {
		if _, err := r.Reconcile(ctx, req); err != nil {
			t.Fatal(err)
		}
	}
	pod := &corev1.Pod{}
	if err := c.Get(ctx, types.NamespacedName{Name: "pw-demo", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable", Message: "0/3 nodes are available:\n3 Insufficient cpu. " + strings.Repeat("x", 400)}}
	if err := c.Status().Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	status := workspaceStatus(t, c, req)
	msg, _ := status["message"].(string)
	if status["phase"] != "Pending" || !strings.HasPrefix(msg, "Unschedulable: 0/3 nodes are available: 3 Insufficient cpu.") || len(msg) > 200 || strings.Contains(msg, "\n") {
		t.Fatalf("wrong pending status: %v", status)
	}
	// The message is cleared once the pod is ready.
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	if err := c.Status().Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	status = workspaceStatus(t, c, req)
	if status["phase"] != "Ready" || status["message"] != "" {
		t.Fatalf("message not cleared: %v", status)
	}
}

func TestQuotaRejectionMessage(t *testing.T) {
	ctx := context.Background()
	r, c, req := pendingFixture(t, interceptor.Funcs{Create: func(ctx context.Context, cl client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
		if _, ok := obj.(*corev1.Pod); ok {
			return apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "pw-demo", errors.New("exceeded quota: workspaces, requested: limits.cpu=2, used: limits.cpu=4, limited: limits.cpu=4"))
		}
		return cl.Create(ctx, obj, opts...)
	}})
	if _, err := r.Reconcile(ctx, req); err == nil {
		t.Fatal("expected the rejection to be retried with an error")
	}
	status := workspaceStatus(t, c, req)
	msg, _ := status["message"].(string)
	if status["phase"] != "Pending" || !strings.HasPrefix(msg, "Quota exceeded: ") || !strings.Contains(msg, "limits.cpu") || len(msg) > 200 {
		t.Fatalf("wrong quota status: %v", status)
	}
}

func TestPluginsWrapDaemonCommand(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	w := object()
	w.SetName("demo")
	w.SetNamespace("test")
	w.SetUID("uid")
	w.Object["spec"] = map[string]interface{}{"image": "example/paseo:test", "storage": "4Gi", "ephemeral": true, "bootstrap": map[string]interface{}{"secretName": "profile", "configMapName": "profile", "envSecretName": "profile-env",
		"plugins": []interface{}{map[string]interface{}{"source": "github:a/b", "ref": "v1", "configSecretName": "pw-plugin-x"}, map[string]interface{}{"source": "github:c/d"}}}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, &corev1.Pod{}).WithObjects(w).Build()
	r := &Reconciler{Client: c, Namespace: "test"}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: types.NamespacedName{Name: "demo", Namespace: "test"}}); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(ctx, types.NamespacedName{Name: "pw-demo", Namespace: "test"}, pod); err != nil {
		t.Fatal(err)
	}
	cmd := pod.Spec.Containers[0].Command
	want := []string{"python3", "/usr/local/lib/paseo-workspace/install-plugins.py", "--plugins", `[{"source":"github:a/b","ref":"v1"},{"source":"github:c/d"}]`, "--", "paseo", "daemon", "run"}
	if !slices.Equal(cmd, want) {
		t.Fatalf("command %v", cmd)
	}
	has := func(from []corev1.EnvFromSource) bool {
		for _, e := range from {
			if e.SecretRef != nil && e.SecretRef.Name == "pw-plugin-x" {
				return true
			}
		}
		return false
	}
	if !has(pod.Spec.Containers[0].EnvFrom) || has(pod.Spec.InitContainers[0].EnvFrom) {
		t.Fatal("plugin config must reach the daemon container only")
	}
}

func TestInvalidPluginsAreRejected(t *testing.T) {
	for _, p := range []PluginRef{{Source: ""}, {Source: "-x"}, {Source: "a b"}, {Source: "a", Ref: "-x"}, {Source: "a", ConfigSecretName: "Bad_Name"}} {
		if ValidatePlugins([]PluginRef{p}) == nil {
			t.Fatalf("accepted %+v", p)
		}
	}
	if ValidatePlugins(make([]PluginRef, 17)) == nil {
		t.Fatal("accepted too many plugins")
	}
}
