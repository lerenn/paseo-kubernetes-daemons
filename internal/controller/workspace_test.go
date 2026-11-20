package controller

import (
	"context"
	"fmt"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"slices"
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
