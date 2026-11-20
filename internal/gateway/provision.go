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

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const requestAnnotation = "workspaces.paseo.sh/gateway-request"
const optionsAnnotation = "workspaces.paseo.sh/gateway-options"

// Provisioner creates one environment per idempotency key. The profile name
// must come from trusted gateway configuration, never from an untrusted client.
type Provisioner struct {
	Client         client.Client
	Namespace      string
	Image          string
	Profile        string
	Docker         bool
	Persistent     bool
	MainConnection string
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
	if len(validation.IsDNS1123Subdomain(p.Profile)) != 0 || len(p.Profile) > 59 {
		return nil, errors.New("invalid credential profile name")
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

	// A profile consists of three immutable, similarly owned resources. Check
	// all of them before requesting a pod, including the repository metadata.
	var files, env corev1.Secret
	var config corev1.ConfigMap
	for _, item := range []struct {
		name   string
		object client.Object
	}{
		{p.Profile, &files}, {p.Profile + "-env", &env}, {p.Profile, &config},
	} {
		if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: item.name}, item.object); err != nil {
			return nil, fmt.Errorf("credential profile %q is unavailable: %w", p.Profile, err)
		}
	}
	owner := files.Labels["workspaces.paseo.sh/profile-owner"]
	if owner == "" || env.Labels["workspaces.paseo.sh/profile-owner"] != owner || config.Labels["workspaces.paseo.sh/profile-owner"] != owner || files.Immutable == nil || !*files.Immutable || env.Immutable == nil || !*env.Immutable || config.Immutable == nil || !*config.Immutable {
		return nil, errors.New("credential profile is incomplete or inconsistent; sync it again")
	}
	var fileData map[string]string
	if json.Unmarshal(files.Data["files.json"], &fileData) != nil || fileData == nil {
		return nil, errors.New("credential profile files are invalid; sync it again")
	}
	if _, ok := fileData["config.toml"]; !ok {
		return nil, errors.New("credential profile configuration is missing; sync it again")
	}
	var bootstrap struct {
		Repository *struct {
			URL string `json:"url"`
		} `json:"repository"`
		Trust     bool     `json:"trustRepository"`
		Providers []string `json:"providers"`
		MCPs      []string `json:"mcps"`
	}
	if err := json.Unmarshal([]byte(config.Data["bootstrap.json"]), &bootstrap); err != nil {
		return nil, errors.New("credential profile configuration is invalid; sync it again")
	}
	if requirements.Provider != "" {
		allowed := map[string][]string{"codex": {"codex-login", "openai-key"}, "claude": {"anthropic-key"}, "gemini": {"gemini-key"}}
		matched := false
		for _, credential := range allowed[requirements.Provider] {
			for _, selected := range bootstrap.Providers {
				if credential == selected {
					matched = true
				}
			}
		}
		if !matched {
			return nil, fmt.Errorf("credentials for provider %q are not synced; sync the profile again", requirements.Provider)
		}
		usable := false
		for _, selected := range bootstrap.Providers {
			switch {
			case requirements.Provider == "codex" && selected == "codex-login":
				var auth struct {
					Tokens struct {
						AccessToken string `json:"access_token"`
					} `json:"tokens"`
				}
				usable = json.Unmarshal([]byte(fileData["auth.json"]), &auth) == nil && auth.Tokens.AccessToken != ""
			case requirements.Provider == "codex" && selected == "openai-key":
				usable = len(env.Data["OPENAI_API_KEY"]) > 0
			case requirements.Provider == "claude" && selected == "anthropic-key":
				usable = len(env.Data["ANTHROPIC_API_KEY"]) > 0
			case requirements.Provider == "gemini" && selected == "gemini-key":
				usable = len(env.Data["GEMINI_API_KEY"]) > 0
			}
			if usable {
				break
			}
		}
		if !usable {
			return nil, fmt.Errorf("credentials for provider %q are missing; sync the profile again", requirements.Provider)
		}
	}
	for _, requested := range requirements.MCPs {
		found := false
		for _, selected := range bootstrap.MCPs {
			if requested == selected {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("MCP %q is not synced; sync the profile again", requested)
		}
	}
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
		"bootstrap": map[string]interface{}{"secretName": p.Profile, "configMapName": p.Profile, "envSecretName": p.Profile + "-env"},
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
	return obj, nil
}

func existing(obj *unstructured.Unstructured, digest, optionsDigest string, p *Provisioner) (*unstructured.Unstructured, error) {
	image, _, _ := unstructured.NestedString(obj.Object, "spec", "image")
	profile, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "secretName")
	docker, _, _ := unstructured.NestedBool(obj.Object, "spec", "docker", "enabled")
	ephemeral, _, _ := unstructured.NestedBool(obj.Object, "spec", "ephemeral")
	if obj.GetAnnotations()[requestAnnotation] != digest || obj.GetAnnotations()[optionsAnnotation] != optionsDigest || image != p.Image || profile != p.Profile || docker != p.Docker || ephemeral == p.Persistent || obj.GetDeletionTimestamp() != nil {
		return nil, errors.New("workspace request conflicts with an existing environment")
	}
	return obj, nil
}
