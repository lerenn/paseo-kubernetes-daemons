package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
)

const (
	ownerLabel = "workspaces.paseo.sh/profile-owner"
	kindLabel  = "workspaces.paseo.sh/kind"
)

// providerEnvKeys maps a provider credential id to the environment variable it supplies.
var providerEnvKeys = map[string]string{
	"openai-key":    "OPENAI_API_KEY",
	"anthropic-key": "ANTHROPIC_API_KEY",
	"gemini-key":    "GEMINI_API_KEY",
	"github-token":  "GITHUB_TOKEN",
}

func validProfileName(name string) error {
	if name == "" {
		return errors.New("profile name is missing")
	}
	if len(name) > 59 || len(validation.IsDNS1123Subdomain(name)) != 0 {
		return errors.New("invalid profile name")
	}
	return nil
}

// projectBootstrap is the project ConfigMap's bootstrap.json. In provider mode Providers and MCPs
// narrow the shared set: absent (nil) means all, an empty list means none.
type projectBootstrap struct {
	Repository *struct {
		URL string `json:"url"`
	} `json:"repository"`
	Trust       bool     `json:"trustRepository"`
	Providers   []string `json:"providers"`
	MCPs        []string `json:"mcps"`
	ProjectMCPs []string `json:"projectMcps"`
	// Legacy profiles also carry the provider snapshot here.
	Snapshot []json.RawMessage       `json:"providerSnapshot"`
	Controls map[string][]wireObject `json:"providerControls"`
}

// providerSet is the content of the provider ConfigMap's providers.json.
type providerSet struct {
	Providers []string                `json:"providers"`
	MCPs      []string                `json:"mcps"`
	MCPEnv    map[string][]string     `json:"mcpEnv"`
	Snapshot  []json.RawMessage       `json:"providerSnapshot"`
	Controls  map[string][]wireObject `json:"providerControls"`
	files     map[string]string
	env       corev1.Secret
}

type profileData struct {
	Files     map[string]string
	Env       corev1.Secret
	Bootstrap projectBootstrap
	Set       *providerSet
}

func owned(labels map[string]string, immutable *bool, owner, kind string) bool {
	if owner == "" || labels[ownerLabel] != owner || immutable == nil || !*immutable {
		return false
	}
	return kind == "" || labels[kindLabel] == kind
}

func (p *Provisioner) triple(ctx context.Context, name string) (files, env corev1.Secret, config corev1.ConfigMap, err error) {
	for _, item := range []struct {
		name   string
		object interface{}
	}{{name, &files}, {name + "-env", &env}, {name, &config}} {
		key := types.NamespacedName{Namespace: p.Namespace, Name: item.name}
		switch o := item.object.(type) {
		case *corev1.Secret:
			err = p.Client.Get(ctx, key, o)
		case *corev1.ConfigMap:
			err = p.Client.Get(ctx, key, o)
		}
		if err != nil {
			return files, env, config, fmt.Errorf("credential profile %q is unavailable: %w", name, err)
		}
	}
	return files, env, config, nil
}

// loadProfile reads and cross-checks every immutable object of the profile: three for a legacy
// profile, six when a provider set is paired with the project.
func (p *Provisioner) loadProfile(ctx context.Context) (*profileData, error) {
	files, env, config, err := p.triple(ctx, p.Profile)
	if err != nil {
		return nil, err
	}
	kind := ""
	if p.Providers != "" {
		kind = "project"
	}
	owner := files.Labels[ownerLabel]
	if !owned(files.Labels, files.Immutable, owner, kind) || !owned(env.Labels, env.Immutable, owner, kind) || !owned(config.Labels, config.Immutable, owner, kind) {
		return nil, errors.New("credential profile is incomplete or inconsistent; sync it again")
	}
	result := &profileData{Env: env}
	if json.Unmarshal(files.Data["files.json"], &result.Files) != nil || result.Files == nil {
		return nil, errors.New("credential profile files are invalid; sync it again")
	}
	if _, ok := result.Files["config.toml"]; !ok {
		return nil, errors.New("credential profile configuration is missing; sync it again")
	}
	if err := json.Unmarshal([]byte(config.Data["bootstrap.json"]), &result.Bootstrap); err != nil {
		return nil, errors.New("credential profile configuration is invalid; sync it again")
	}
	if p.Providers == "" {
		return result, nil
	}
	// The provider set must come from the same installation as the project profile.
	sfiles, senv, sconfig, err := p.triple(ctx, p.Providers)
	if err != nil {
		return nil, fmt.Errorf("provider set %q is unavailable: %w", p.Providers, err)
	}
	if !owned(sfiles.Labels, sfiles.Immutable, owner, "providers") || !owned(senv.Labels, senv.Immutable, owner, "providers") || !owned(sconfig.Labels, sconfig.Immutable, owner, "providers") {
		return nil, errors.New("provider set is incomplete or belongs to another installation; sync it again")
	}
	set := &providerSet{env: senv}
	if json.Unmarshal([]byte(sconfig.Data["providers.json"]), set) != nil {
		return nil, errors.New("provider set configuration is invalid; sync it again")
	}
	if json.Unmarshal(sfiles.Data["files.json"], &set.files) != nil || set.files == nil {
		return nil, errors.New("provider set files are invalid; sync it again")
	}
	result.Set = set
	return result, nil
}

func subset(all, narrow []string) ([]string, error) {
	if narrow == nil {
		return append([]string{}, all...), nil
	}
	have := map[string]bool{}
	for _, v := range all {
		have[v] = true
	}
	result := []string{}
	for _, v := range narrow {
		if !have[v] {
			return nil, fmt.Errorf("%q is not part of the synced provider set; sync the project again", v)
		}
		result = append(result, v)
	}
	return result, nil
}

// selection returns the credentials and MCPs this profile may use, after narrowing.
func (d *profileData) selection() (providers, mcps []string, err error) {
	if d.Set == nil {
		return d.Bootstrap.Providers, d.Bootstrap.MCPs, nil
	}
	if providers, err = subset(d.Set.Providers, d.Bootstrap.Providers); err != nil {
		return nil, nil, err
	}
	if mcps, err = subset(d.Set.MCPs, d.Bootstrap.MCPs); err != nil {
		return nil, nil, err
	}
	return providers, append(mcps, d.Bootstrap.ProjectMCPs...), nil
}

// check applies the provider and MCP gates of the request to the effective selection.
func (d *profileData) check(requirements Requirements) error {
	providers, mcps, err := d.selection()
	if err != nil {
		return err
	}
	authFiles, env := d.Files, d.Env
	if d.Set != nil {
		authFiles, env = d.Set.files, d.Set.env
	}
	if requirements.Provider != "" {
		allowed := map[string][]string{"codex": {"codex-login", "openai-key"}, "claude": {"anthropic-key"}, "gemini": {"gemini-key"}}
		matched := false
		for _, credential := range allowed[requirements.Provider] {
			for _, selected := range providers {
				if credential == selected {
					matched = true
				}
			}
		}
		if !matched {
			return fmt.Errorf("credentials for provider %q are not synced; sync the profile again", requirements.Provider)
		}
		usable := false
		for _, selected := range providers {
			switch {
			case requirements.Provider == "codex" && selected == "codex-login":
				var auth struct {
					Tokens struct {
						AccessToken string `json:"access_token"`
					} `json:"tokens"`
				}
				usable = json.Unmarshal([]byte(authFiles["auth.json"]), &auth) == nil && auth.Tokens.AccessToken != ""
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
			return fmt.Errorf("credentials for provider %q are missing; sync the profile again", requirements.Provider)
		}
	}
	for _, requested := range requirements.MCPs {
		found := false
		for _, selected := range mcps {
			if requested == selected {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("MCP %q is not synced; sync the profile again", requested)
		}
	}
	return nil
}

// providerRefs is the spec.bootstrap.providers value: the explicit, narrowed lists the controller
// enforces (an absent list means none there, so "all" is spelled out here).
func (d *profileData) providerRefs(name string) map[string]interface{} {
	providers, _, _ := d.selection()
	mcps, _ := subset(d.Set.MCPs, d.Bootstrap.MCPs)
	envKeys, files := map[string]bool{}, []string{}
	for _, id := range providers {
		if key := providerEnvKeys[id]; key != "" {
			envKeys[key] = true
		}
		if id == "codex-login" {
			if _, ok := d.Set.files["auth.json"]; ok {
				files = append(files, "auth.json")
			}
		}
	}
	for _, mcp := range mcps {
		for _, key := range d.Set.MCPEnv[mcp] {
			envKeys[key] = true
		}
	}
	if _, ok := d.Set.files[".credentials.json"]; ok && len(mcps) > 0 {
		files = append(files, ".credentials.json")
	}
	keys := []string{}
	for key := range envKeys {
		if _, ok := d.Set.env.Data[key]; ok {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	sort.Strings(files)
	return map[string]interface{}{"secretName": name, "configMapName": name, "envSecretName": name + "-env", "envKeys": toAny(keys), "files": toAny(files), "mcps": toAny(mcps)}
}

func toAny(values []string) []interface{} {
	result := make([]interface{}, len(values))
	for i, v := range values {
		result[i] = v
	}
	return result
}
