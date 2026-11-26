package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
)

type Project struct {
	ID         string
	Name       string
	Root       string
	Repository string
}
type Discovery struct {
	Project   *Project
	Providers []json.RawMessage
	Controls  map[string][]wireObject
}

// Discover reads non-secret profile metadata for the empty-host picker. The
// operator must still validate the corresponding Secrets before provisioning.
func (p *Provisioner) Discover(ctx context.Context) (Discovery, error) {
	if p.Profile == "" || p.Namespace == "" {
		return Discovery{}, errors.New("sync a credential profile before using the Kubernetes host")
	}
	var config corev1.ConfigMap
	if err := p.Client.Get(ctx, types.NamespacedName{Name: p.Profile, Namespace: p.Namespace}, &config); err != nil {
		return Discovery{}, fmt.Errorf("credential profile unavailable: %w", err)
	}
	if config.Immutable == nil || !*config.Immutable || config.Labels["daemons.paseo.sh/profile-owner"] == "" {
		return Discovery{}, errors.New("profile discovery metadata is not a synced snapshot")
	}
	var data struct {
		Repository *struct {
			URL string `json:"url"`
		} `json:"repository"`
		Trust     bool                    `json:"trustRepository"`
		Providers []json.RawMessage       `json:"providerSnapshot"`
		Controls  map[string][]wireObject `json:"providerControls"`
	}
	if err := json.Unmarshal([]byte(config.Data["bootstrap.json"]), &data); err != nil {
		return Discovery{}, errors.New("profile discovery metadata is invalid")
	}
	result := Discovery{Providers: data.Providers, Controls: data.Controls}
	if p.Providers != "" {
		// Snapshot and controls live in the shared provider set, which must be a synced snapshot of the
		// same installation as the project profile.
		var set corev1.ConfigMap
		if err := p.Client.Get(ctx, types.NamespacedName{Name: p.Providers, Namespace: p.Namespace}, &set); err != nil {
			return Discovery{}, fmt.Errorf("provider set unavailable: %w", err)
		}
		if !owned(set.Labels, set.Immutable, config.Labels[ownerLabel], "providers") {
			return Discovery{}, errors.New("provider set metadata is not a synced snapshot of this installation")
		}
		var shared providerSet
		if err := json.Unmarshal([]byte(set.Data["providers.json"]), &shared); err != nil {
			return Discovery{}, errors.New("provider set metadata is invalid")
		}
		result.Providers, result.Controls = shared.Snapshot, shared.Controls
	}
	if data.Repository == nil {
		return result, nil
	}
	if !data.Trust || strings.TrimSpace(data.Repository.URL) == "" {
		return Discovery{}, errors.New("profile repository is not approved")
	}
	repository := data.Repository.URL
	var repoPath string
	if strings.HasPrefix(repository, "git@") {
		if i := strings.IndexByte(repository, ':'); i >= 0 {
			repoPath = repository[i+1:]
		}
	} else {
		parsed, err := url.Parse(repository)
		if err != nil {
			return Discovery{}, errors.New("profile repository is invalid")
		}
		repoPath = parsed.Path
	}
	name := strings.TrimSuffix(path.Base(repoPath), ".git")
	if name == "" || name == "." || name == "/" {
		return Discovery{}, errors.New("profile repository has no project name")
	}
	hash := sha256.Sum256([]byte(repository))
	id := hex.EncodeToString(hash[:16])
	result.Project = &Project{ID: "prj_" + id, Name: name, Root: "/__paseo_kubernetes_projects/" + id, Repository: repository}
	return result, nil
}

func (d Discovery) ProjectList(requestID string) (Frame, error) {
	projects := []interface{}{}
	if d.Project != nil {
		p := d.Project
		projects = append(projects, map[string]interface{}{"projectId": p.ID, "projectDisplayName": p.Name, "projectRootPath": p.Root, "projectKind": "git"})
	}
	return sessionFrame(map[string]interface{}{"type": "project.list.response", "payload": map[string]interface{}{"requestId": requestID, "projects": projects}})
}

func (d Discovery) ProviderSnapshot(requestID string) (Frame, error) {
	providers := d.Providers
	if providers == nil {
		providers = []json.RawMessage{}
	}
	return sessionFrame(map[string]interface{}{"type": "get_providers_snapshot_response", "payload": map[string]interface{}{"requestId": requestID, "entries": providers, "generatedAt": time.Now().UTC().Format(time.RFC3339Nano)}})
}

// HandleDiscovery returns responses for host-level picker requests. Caller
// must authorize the operation before invoking it.
func (p *Provisioner) HandleDiscovery(ctx context.Context, input Frame) (Frame, error) {
	if input.Binary {
		return Frame{}, errors.New("discovery request must be text")
	}
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		} `json:"message"`
	}
	if json.Unmarshal(input.Data, &env) != nil || env.Type != "session" || env.Message.RequestID == "" {
		return Frame{}, errors.New("invalid discovery request")
	}
	d, err := p.Discover(ctx)
	if err != nil {
		return Frame{}, err
	}
	switch env.Message.Type {
	case "project.list.request":
		return d.ProjectList(env.Message.RequestID)
	case "get_providers_snapshot_request":
		return d.ProviderSnapshot(env.Message.RequestID)
	default:
		return Frame{}, errors.New("unsupported discovery request")
	}
}
