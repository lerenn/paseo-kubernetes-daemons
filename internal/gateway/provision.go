// Package gateway contains the Kubernetes side of the virtual Paseo host.
package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const requestAnnotation = "workspaces.paseo.sh/gateway-request"
const optionsAnnotation = "workspaces.paseo.sh/gateway-options"

// Provisioner creates one environment per idempotency key. The profile name
// must come from trusted gateway configuration, never from an untrusted client.
type Provisioner struct {
	Client    client.Client
	Namespace string
	Image     string
	Profile   string
	// Providers is the shared provider set the profile is paired with; empty means a legacy profile.
	Providers      string
	Docker         bool
	Persistent     bool
	MainConnection string
	// PendingGrace overrides DefaultPendingGrace (negative reports immediately).
	PendingGrace time.Duration
}

// Create is safe to retry after a timeout or gateway restart. An existing
// workspace with different options is rejected instead of silently reused.
func (p *Provisioner) Create(ctx context.Context, key string) (*unstructured.Unstructured, error) {
	return p.CreateWithRequirements(ctx, key, Requirements{})
}

// Requirements describe the client's requested provider, repository and MCPs.
// The gateway must check these against the selected profile before provisioning.
type Requirements struct {
	Provider   string   `json:"provider,omitempty"`
	Repository string   `json:"repository,omitempty"`
	MCPs       []string `json:"mcps,omitempty"`
}

func (p *Provisioner) CreateWithRequirements(ctx context.Context, key string, requirements Requirements) (*unstructured.Unstructured, error) {
	if len(key) == 0 || len(key) > 512 {
		return nil, errors.New("idempotency key must contain 1 to 512 bytes")
	}
	if p.Namespace == "" || p.Image == "" || p.Profile == "" {
		return nil, errors.New("gateway namespace, workspace image and synced credential profile are required")
	}
	if validProfileName(p.Profile) != nil {
		return nil, errors.New("invalid credential profile name")
	}
	if p.Providers != "" && validProfileName(p.Providers) != nil {
		return nil, errors.New("invalid provider set name")
	}
	sum := sha256.Sum256([]byte(key))
	digest := hex.EncodeToString(sum[:])
	options, err := json.Marshal(requirements)
	if err != nil {
		return nil, fmt.Errorf("encode workspace requirements: %w", err)
	}
	optionsSum := sha256.Sum256(options)
	optionsDigest := hex.EncodeToString(optionsSum[:])
	name := "gw-" + digest[:40]
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(controller.GVK)
	lookup := types.NamespacedName{Namespace: p.Namespace, Name: name}
	if err := p.Client.Get(ctx, lookup, obj); err == nil {
		return existing(obj, digest, optionsDigest, p)
	} else if !apierrors.IsNotFound(err) {
		return nil, fmt.Errorf("find workspace: %w", err)
	}

	profile, err := p.loadProfile(ctx)
	if err != nil {
		return nil, err
	}
	if err := profile.check(requirements); err != nil {
		return nil, err
	}
	bootstrap := profile.Bootstrap
	workingDirectory := "/workspace"
	if bootstrap.Repository != nil {
		if strings.TrimSpace(bootstrap.Repository.URL) == "" || !bootstrap.Trust {
			return nil, errors.New("repository profile is incomplete or untrusted")
		}
		workingDirectory = "/workspace/repository"
	}
	if requirements.Repository != "" && (bootstrap.Repository == nil || requirements.Repository != bootstrap.Repository.URL) {
		return nil, errors.New("requested repository is not approved in the synced profile")
	}
	bootstrapSpec := map[string]interface{}{"secretName": p.Profile, "configMapName": p.Profile, "envSecretName": p.Profile + "-env"}
	if profile.Set != nil {
		bootstrapSpec["providers"] = profile.providerRefs(p.Providers)
	}
	obj.SetName(name)
	obj.SetNamespace(p.Namespace)
	obj.SetAnnotations(map[string]string{requestAnnotation: digest, optionsAnnotation: optionsDigest})
	storage := "4Gi"
	if p.Persistent {
		storage = "10Gi"
	}
	obj.Object["spec"] = map[string]interface{}{
		"gateway": true,
		"image":   p.Image, "ephemeral": !p.Persistent, "storage": storage, "workingDirectory": workingDirectory,
		"docker":    map[string]interface{}{"enabled": p.Docker},
		"bootstrap": bootstrapSpec,
		"resources": map[string]interface{}{"requests": map[string]interface{}{"cpu": "250m", "memory": "512Mi", "ephemeral-storage": "1Gi"}, "limits": map[string]interface{}{"cpu": "2", "memory": "4Gi", "ephemeral-storage": "4Gi"}},
	}
	if err := p.Client.Create(ctx, obj); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return nil, fmt.Errorf("create workspace: %w", err)
		}
		obj = &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := p.Client.Get(ctx, lookup, obj); err != nil {
			return nil, fmt.Errorf("read concurrently created workspace: %w", err)
		}
		return existing(obj, digest, optionsDigest, p)
	}
	if profile.Set != nil {
		// A CRD from before the provider sets prunes the unknown field silently, which would start a pod
		// without any credentials. Remove it again and say what to do.
		if _, found, _ := unstructured.NestedMap(obj.Object, "spec", "bootstrap", "providers"); !found {
			_ = p.Client.Delete(ctx, obj)
			return nil, errors.New("CRD out of date: apply config/crd.yaml before creating workspaces with provider sets")
		}
	}
	return obj, nil
}

func existing(obj *unstructured.Unstructured, digest, optionsDigest string, p *Provisioner) (*unstructured.Unstructured, error) {
	image, _, _ := unstructured.NestedString(obj.Object, "spec", "image")
	profile, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "secretName")
	providers, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "providers", "secretName")
	docker, _, _ := unstructured.NestedBool(obj.Object, "spec", "docker", "enabled")
	ephemeral, _, _ := unstructured.NestedBool(obj.Object, "spec", "ephemeral")
	if obj.GetAnnotations()[requestAnnotation] != digest || obj.GetAnnotations()[optionsAnnotation] != optionsDigest || image != p.Image || profile != p.Profile || providers != p.Providers || docker != p.Docker || ephemeral == p.Persistent || obj.GetDeletionTimestamp() != nil {
		return nil, errors.New("workspace request conflicts with an existing environment")
	}
	return obj, nil
}
