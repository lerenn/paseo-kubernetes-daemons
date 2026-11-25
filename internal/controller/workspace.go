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
	"strings"
	"time"
)

var GVK = schema.GroupVersionKind{Group: "workspaces.paseo.sh", Version: "v1alpha1", Kind: "PaseoWorkspace"}

const GatewayAuthSecret = "paseo-workspaces-gateway-auth"

type Bootstrap struct {
	SecretName    string `json:"secretName"`
	ConfigMapName string `json:"configMapName"`
	EnvSecretName string `json:"envSecretName"`
	// Providers optionally references a shared, immutable provider set. Nil keeps the legacy single-profile path.
	Providers *ProviderRefs `json:"providers,omitempty"`
}

// ProviderRefs names a provider set and the subset of it this workspace may read.
// Absent EnvKeys, Files or MCPs mean none of that kind, never all.
type ProviderRefs struct {
	SecretName    string   `json:"secretName"`
	ConfigMapName string   `json:"configMapName"`
	EnvSecretName string   `json:"envSecretName"`
	EnvKeys       []string `json:"envKeys,omitempty"`
	Files         []string `json:"files,omitempty"`
	MCPs          []string `json:"mcps,omitempty"`
}
type Docker struct {
	Enabled bool `json:"enabled"`
	// Resources and DataSize override the sidecar defaults when set.
	Resources *corev1.ResourceRequirements `json:"resources,omitempty"`
	DataSize  string                       `json:"dataSize,omitempty"`
}
type Spec struct {
	Gateway          bool                        `json:"gateway,omitempty"`
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
	Namespace       string
	ImagePullSecret string
	// DockerImage is the Docker-in-Docker sidecar image; empty means DefaultDockerImage.
	DockerImage string
	// DockerMTU, when positive, is applied to dockerd and its default bridge networks.
	DockerMTU int
	// DockerRegistryMirrors are Docker Hub mirrors passed to dockerd.
	DockerRegistryMirrors []string
}

// DefaultDockerImage is the Docker-in-Docker sidecar image when none is configured.
const DefaultDockerImage = "docker:29.0.0-dind"

func (r *Reconciler) dockerdArgs() []string {
	// The containerd image store breaks pushes and concurrent pulls in nested Docker.
	args := []string{"dockerd", "--host=unix:///var/run/docker/docker.sock", "--group=1000", "--feature=containerd-snapshotter=false"}
	if r.DockerMTU > 0 {
		args = append(args, fmt.Sprintf("--mtu=%d", r.DockerMTU), fmt.Sprintf("--default-network-opt=bridge=com.docker.network.driver.mtu=%d", r.DockerMTU))
	}
	for _, mirror := range r.DockerRegistryMirrors {
		args = append(args, "--registry-mirror="+mirror)
	}
	return args
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
	if r.ImagePullSecret != "" {
		pod.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: r.ImagePullSecret}}
	}
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
		if p := s.Bootstrap.Providers; p != nil && (p.SecretName == "" || p.ConfigMapName == "" || p.EnvSecretName == "") {
			return ctrl.Result{}, fmt.Errorf("all provider references are required")
		}
		mode := int32(0440)
		pod.Spec.Volumes = append(pod.Spec.Volumes,
			corev1.Volume{Name: "bootstrap-credentials", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: s.Bootstrap.SecretName, DefaultMode: &mode}}},
			corev1.Volume{Name: "bootstrap-config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: s.Bootstrap.ConfigMapName}, DefaultMode: &mode}}})
		env := corev1.EnvFromSource{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: s.Bootstrap.EnvSecretName}}}
		pod.Spec.Containers[0].EnvFrom = append(pod.Spec.Containers[0].EnvFrom, env)
		initMounts := []corev1.VolumeMount{{Name: "workspace", MountPath: "/workspace"}, {Name: "bootstrap-credentials", MountPath: "/var/run/paseo/credentials", ReadOnly: true}, {Name: "bootstrap-config", MountPath: "/var/run/paseo/config", ReadOnly: true}}
		initCommand := []string{"python3", "/usr/local/lib/paseo-workspace/bootstrap.py", "--profile", s.Bootstrap.SecretName}
		if p := s.Bootstrap.Providers; p != nil {
			// Shared providers are mounted in the init container only. Env vars are exposed one key at a
			// time so keys outside the subset never reach the daemon.
			pod.Spec.Volumes = append(pod.Spec.Volumes,
				corev1.Volume{Name: "provider-credentials", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: p.SecretName, DefaultMode: &mode}}},
				corev1.Volume{Name: "provider-config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: p.ConfigMapName}, DefaultMode: &mode}}})
			for _, key := range p.EnvKeys {
				pod.Spec.Containers[0].Env = append(pod.Spec.Containers[0].Env, corev1.EnvVar{Name: key, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: p.EnvSecretName}, Key: key}}})
			}
			initMounts = append(initMounts, corev1.VolumeMount{Name: "provider-credentials", MountPath: "/var/run/paseo/providers/credentials", ReadOnly: true}, corev1.VolumeMount{Name: "provider-config", MountPath: "/var/run/paseo/providers/config", ReadOnly: true})
			initCommand = append(initCommand, "--providers", p.SecretName, "--providers-secrets", "/var/run/paseo/providers/credentials", "--providers-config", "/var/run/paseo/providers/config")
			// Always passed: an empty value means none, so the bootstrap never falls back to "all".
			initCommand = append(initCommand, "--provider-files="+strings.Join(p.Files, ","), "--provider-mcps="+strings.Join(p.MCPs, ","))
		}
		pod.Spec.InitContainers = []corev1.Container{{Name: "bootstrap", Image: s.Image,
			Command: initCommand,
			Env:     pod.Spec.Containers[0].Env, EnvFrom: pod.Spec.Containers[0].EnvFrom, Resources: s.Resources, SecurityContext: container.SecurityContext,
			VolumeMounts: initMounts}}
	}
	if s.Docker != nil && s.Docker.Enabled {
		// Use a Unix socket only: the stock entrypoint otherwise also opens TCP.
		root := int64(0)
		dockerSize := resource.MustParse("10Gi")
		if s.Docker.DataSize != "" {
			q, err := resource.ParseQuantity(s.Docker.DataSize)
			if err != nil {
				return ctrl.Result{}, fmt.Errorf("invalid docker dataSize: %w", err)
			}
			dockerSize = q
		}
		dockerResources := corev1.ResourceRequirements{
			Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("256Mi"), corev1.ResourceEphemeralStorage: resource.MustParse("1Gi")},
			Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi"), corev1.ResourceEphemeralStorage: resource.MustParse("12Gi")}}
		if s.Docker.Resources != nil {
			dockerResources = *s.Docker.Resources
		}
		socket := corev1.VolumeMount{Name: "docker-socket", MountPath: "/var/run/docker"}
		pod.Spec.Volumes = append(pod.Spec.Volumes,
			corev1.Volume{Name: "docker-socket", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: quantityPtr("1Mi")}}},
			corev1.Volume{Name: "docker-data", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &dockerSize}}})
		daemon := &pod.Spec.Containers[0]
		daemon.Env = append(daemon.Env, corev1.EnvVar{Name: "DOCKER_HOST", Value: "unix:///var/run/docker/docker.sock"})
		daemon.VolumeMounts = append(daemon.VolumeMounts, socket)
		// Pod readiness must wait for both the daemon and Docker.
		dockerImage := r.DockerImage
		if dockerImage == "" {
			dockerImage = DefaultDockerImage
		}
		pod.Spec.Containers = append(pod.Spec.Containers, corev1.Container{
			Name: "docker", Image: dockerImage,
			Args:            r.dockerdArgs(),
			Env:             []corev1.EnvVar{{Name: "DOCKER_TLS_CERTDIR", Value: ""}},
			SecurityContext: &corev1.SecurityContext{Privileged: boolPtr(true), RunAsUser: &root, RunAsGroup: &root, RunAsNonRoot: boolPtr(false)},
			Resources:       dockerResources,
			VolumeMounts:    []corev1.VolumeMount{socket, {Name: "docker-data", MountPath: "/var/lib/docker"}, {Name: "workspace", MountPath: "/workspace"}},
			ReadinessProbe:  &corev1.Probe{ProbeHandler: corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"docker", "--host=unix:///var/run/docker/docker.sock", "info"}}}, PeriodSeconds: 5},
		})
	}
	if s.Gateway {
		alias := GatewayRoot(w.GetName())
		pod.Spec.Containers[0].Env = append(pod.Spec.Containers[0].Env, corev1.EnvVar{Name: "PASEO_PASSWORD", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: GatewayAuthSecret}, Key: "password"}}}, corev1.EnvVar{Name: "PASEO_HOSTNAMES", Value: name + "." + req.Namespace + ".svc," + name + "." + req.Namespace + ".svc.cluster.local," + name})
		pod.Spec.Containers[0].WorkingDir = alias + workingDir[len("/workspace"):]
		for i := range pod.Spec.Containers {
			pod.Spec.Containers[i].VolumeMounts = append(pod.Spec.Containers[i].VolumeMounts, corev1.VolumeMount{Name: "workspace", MountPath: alias})
		}
		for i := range pod.Spec.Containers[0].Env {
			if pod.Spec.Containers[0].Env[i].Name == "PASEO_HOME" {
				pod.Spec.Containers[0].Env[i].Value = alias + "/.paseo"
			}
		}
		for i := range pod.Spec.InitContainers {
			pod.Spec.InitContainers[i].VolumeMounts = append(pod.Spec.InitContainers[i].VolumeMounts, corev1.VolumeMount{Name: "workspace", MountPath: alias})
			pod.Spec.InitContainers[i].Command = append(pod.Spec.InitContainers[i].Command, "--alias-root", alias)
		}
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
	for _, state := range actual.Status.ContainerStatuses {
		if state.State.Waiting != nil {
			reason := state.State.Waiting.Reason
			if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
				phase = "Failed"
				message = reason
			}
		}
		if state.State.Terminated != nil && state.State.Terminated.ExitCode != 0 {
			phase = "Failed"
			message = fmt.Sprintf("container %s exited with code %d", state.Name, state.State.Terminated.ExitCode)
		}
	}
	status := map[string]interface{}{"message": message, "phase": phase, "endpoint": fmt.Sprintf("%s.%s.svc:6767", name, req.Namespace), "observedGeneration": w.GetGeneration(), "podUID": string(actual.UID)}
	old := w.DeepCopy()
	w.Object["status"] = status
	if err = r.Status().Patch(ctx, w, client.MergeFrom(old)); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
}
func boolPtr(v bool) *bool { return &v }

// GatewayRoot is mounted at the same absolute path in every container in a
// workspace pod, including Docker, so host-visible paths remain valid there.
func GatewayRoot(name string) string { return "/__paseo_kubernetes/" + name + "/workspace" }

func quantityPtr(value string) *resource.Quantity { q := resource.MustParse(value); return &q }
