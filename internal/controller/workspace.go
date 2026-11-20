package controller

import (
	"context"
	"encoding/json"
	"fmt"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"time"
)

var GVK = schema.GroupVersionKind{Group: "workspaces.paseo.sh", Version: "v1alpha1", Kind: "PaseoWorkspace"}

type Bootstrap struct {
	SecretName    string `json:"secretName"`
	ConfigMapName string `json:"configMapName"`
	EnvSecretName string `json:"envSecretName"`
}
type Docker struct {
	Enabled bool `json:"enabled"`
}
type Spec struct {
	Docker           *Docker                     `json:"docker,omitempty"`
	Bootstrap        *Bootstrap                  `json:"bootstrap,omitempty"`
	Ephemeral        bool                        `json:"ephemeral,omitempty"`
	WorkingDirectory string                      `json:"workingDirectory,omitempty"`
	Image            string                      `json:"image"`
	Command          []string                    `json:"command,omitempty"`
	Resources        corev1.ResourceRequirements `json:"resources"`
	Storage          string                      `json:"storage"`
	StorageClassName *string                     `json:"storageClassName,omitempty"`
	SecretName       string                      `json:"secretName,omitempty"`
}
type Reconciler struct {
	client.Client
	Namespace string
}

func object() *unstructured.Unstructured {
	o := &unstructured.Unstructured{}
	o.SetGroupVersionKind(GVK)
	return o
}
func (r *Reconciler) Setup(m ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(m).For(object()).Owns(&corev1.Pod{}).Owns(&corev1.Service{}).Owns(&corev1.PersistentVolumeClaim{}).Complete(r)
}
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	if req.Namespace != r.Namespace {
		return ctrl.Result{}, nil
	}
	w := object()
	if err := r.Get(ctx, req.NamespacedName, w); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !w.GetDeletionTimestamp().IsZero() {
		return ctrl.Result{}, nil
	}
	raw, _, _ := unstructured.NestedMap(w.Object, "spec")
	b, _ := json.Marshal(raw)
	var s Spec
	if err := json.Unmarshal(b, &s); err != nil {
		return ctrl.Result{}, err
	}
	if s.Image == "" {
		return ctrl.Result{}, fmt.Errorf("spec.image is required")
	}
	size, err := resource.ParseQuantity(s.Storage)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("invalid storage: %w", err)
	}
	name := "pw-" + w.GetName()
	labels := map[string]string{"workspaces.paseo.sh/uid": string(w.GetUID())}
	owner := metav1.NewControllerRef(w, GVK)
	owner.BlockOwnerDeletion = nil
	meta := func() metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: req.Namespace, Labels: labels, OwnerReferences: []metav1.OwnerReference{*owner}}
	}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: meta(), Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}, StorageClassName: s.StorageClassName, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: size}}}}
	service := &corev1.Service{ObjectMeta: meta(), Spec: corev1.ServiceSpec{Selector: labels, Ports: []corev1.ServicePort{{Name: "paseo", Port: 6767, TargetPort: intstr.FromInt32(6767)}}}}
	cmd := s.Command
	if len(cmd) == 0 {
		cmd = []string{"paseo", "daemon", "run"}
	}
	workingDir := s.WorkingDirectory
	if workingDir == "" {
		workingDir = "/workspace"
	}
	if workingDir != "/workspace" && workingDir != "/workspace/repository" {
		return ctrl.Result{}, fmt.Errorf("invalid working directory")
	}
	no := false
	uid := int64(1000)
	container := corev1.Container{Name: "daemon", Image: s.Image, Command: cmd, WorkingDir: workingDir, Env: []corev1.EnvVar{{Name: "PASEO_LISTEN", Value: "0.0.0.0:6767"}, {Name: "PASEO_HOME", Value: "/workspace/.paseo"}, {Name: "HOME", Value: "/workspace"}, {Name: "CODEX_HOME", Value: "/workspace/.codex"}}, Resources: s.Resources, Ports: []corev1.ContainerPort{{ContainerPort: 6767}}, VolumeMounts: []corev1.VolumeMount{{Name: "workspace", MountPath: "/workspace"}}, ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(6767)}}, InitialDelaySeconds: 3, PeriodSeconds: 5}, SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}}
	if s.SecretName != "" {
		container.EnvFrom = []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: s.SecretName}}}}
	}
	pod := &corev1.Pod{ObjectMeta: meta(), Spec: corev1.PodSpec{AutomountServiceAccountToken: &no, SecurityContext: &corev1.PodSecurityContext{RunAsUser: &uid, RunAsGroup: &uid, FSGroup: &uid, RunAsNonRoot: boolPtr(true)}, Containers: []corev1.Container{container}, Volumes: []corev1.Volume{{Name: "workspace", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: name}}}}}}
	desiredObjects := []client.Object{service, pod}
	if s.Ephemeral {
		pod.Spec.Volumes[0].VolumeSource = corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &size}}
	} else {
		desiredObjects = append([]client.Object{pvc}, desiredObjects...)
	}
	if s.Bootstrap != nil {
		if s.Bootstrap.SecretName == "" || s.Bootstrap.ConfigMapName == "" || s.Bootstrap.EnvSecretName == "" {
			return ctrl.Result{}, fmt.Errorf("all bootstrap references are required")
		}
		mode := int32(0440)
		pod.Spec.Volumes = append(pod.Spec.Volumes,
			corev1.Volume{Name: "bootstrap-credentials", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: s.Bootstrap.SecretName, DefaultMode: &mode}}},
			corev1.Volume{Name: "bootstrap-config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: s.Bootstrap.ConfigMapName}, DefaultMode: &mode}}})
		env := corev1.EnvFromSource{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: s.Bootstrap.EnvSecretName}}}
		pod.Spec.Containers[0].EnvFrom = append(pod.Spec.Containers[0].EnvFrom, env)
		pod.Spec.InitContainers = []corev1.Container{{Name: "bootstrap", Image: s.Image,
			Command: []string{"python3", "/usr/local/lib/paseo-workspace/bootstrap.py", "--profile", s.Bootstrap.SecretName},
			Env:     pod.Spec.Containers[0].Env, EnvFrom: pod.Spec.Containers[0].EnvFrom, Resources: s.Resources, SecurityContext: container.SecurityContext,
			VolumeMounts: []corev1.VolumeMount{{Name: "workspace", MountPath: "/workspace"}, {Name: "bootstrap-credentials", MountPath: "/var/run/paseo/credentials", ReadOnly: true}, {Name: "bootstrap-config", MountPath: "/var/run/paseo/config", ReadOnly: true}}}}
	}
	if s.Docker != nil && s.Docker.Enabled {
		// Use a Unix socket only: the stock entrypoint otherwise also opens TCP.
		root := int64(0)
		dockerSize := resource.MustParse("10Gi")
		socket := corev1.VolumeMount{Name: "docker-socket", MountPath: "/var/run/docker"}
		pod.Spec.Volumes = append(pod.Spec.Volumes,
			corev1.Volume{Name: "docker-socket", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: quantityPtr("1Mi")}}},
			corev1.Volume{Name: "docker-data", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &dockerSize}}})
		daemon := &pod.Spec.Containers[0]
		daemon.Env = append(daemon.Env, corev1.EnvVar{Name: "DOCKER_HOST", Value: "unix:///var/run/docker/docker.sock"})
		daemon.VolumeMounts = append(daemon.VolumeMounts, socket)
		// Pod readiness must wait for both the daemon and Docker.
		pod.Spec.Containers = append(pod.Spec.Containers, corev1.Container{
			Name: "docker", Image: "docker:29.0.0-dind",
			Args:            []string{"dockerd", "--host=unix:///var/run/docker/docker.sock", "--group=1000"},
			Env:             []corev1.EnvVar{{Name: "DOCKER_TLS_CERTDIR", Value: ""}},
			SecurityContext: &corev1.SecurityContext{Privileged: boolPtr(true), RunAsUser: &root, RunAsGroup: &root, RunAsNonRoot: boolPtr(false)},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("256Mi"), corev1.ResourceEphemeralStorage: resource.MustParse("1Gi")},
				Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi"), corev1.ResourceEphemeralStorage: resource.MustParse("12Gi")}},
			VolumeMounts:   []corev1.VolumeMount{socket, {Name: "docker-data", MountPath: "/var/lib/docker"}, {Name: "workspace", MountPath: "/workspace"}},
			ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"docker", "--host=unix:///var/run/docker/docker.sock", "info"}}}, PeriodSeconds: 5},
		})
	}
	for _, desired := range desiredObjects {
		existing := desired.DeepCopyObject().(client.Object)
		err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: req.Namespace}, existing)
		if apierrors.IsNotFound(err) {
			if err = r.Create(ctx, desired); err != nil {
				return ctrl.Result{}, err
			}
		} else if err != nil {
			return ctrl.Result{}, err
		} else if !controllerutil.HasControllerReference(existing) || !metav1.IsControlledBy(existing, w) {
			return ctrl.Result{}, fmt.Errorf("resource %s is not owned by workspace", name)
		}
	}
	actual := &corev1.Pod{}
	if err = r.Get(ctx, types.NamespacedName{Name: name, Namespace: req.Namespace}, actual); err != nil {
		return ctrl.Result{RequeueAfter: time.Second}, client.IgnoreNotFound(err)
	}
	ready := false
	for _, c := range actual.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			ready = true
		}
	}
	phase := "Pending"
	if ready {
		phase = "Ready"
	}
	if actual.Status.Phase == corev1.PodFailed {
		phase = "Failed"
	}
	message := ""
	for _, state := range actual.Status.InitContainerStatuses {
		if state.State.Waiting != nil {
			message = state.State.Waiting.Reason
			if message == "CrashLoopBackOff" || message == "ImagePullBackOff" || message == "ErrImagePull" {
				phase = "Failed"
			}
		}
		if state.State.Terminated != nil && state.State.Terminated.ExitCode != 0 {
			phase = "Failed"
			message = "Bootstrap failed; inspect the bootstrap init-container logs"
		}
	}
	status := map[string]interface{}{"message": message, "phase": phase, "endpoint": fmt.Sprintf("%s.%s.svc:6767", name, req.Namespace), "observedGeneration": w.GetGeneration()}
	old := w.DeepCopy()
	w.Object["status"] = status
	if err = r.Status().Patch(ctx, w, client.MergeFrom(old)); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
}
func boolPtr(v bool) *bool { return &v }

func quantityPtr(value string) *resource.Quantity { q := resource.MustParse(value); return &q }
