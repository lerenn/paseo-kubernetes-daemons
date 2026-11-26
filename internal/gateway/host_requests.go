package gateway

import (
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"time"

	"github.com/lerenn/paseo-kubernetes-daemons/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func (s *Session) hostRequest(frame Frame) error {
	_, message, _ := messageParts(frame)
	op, id := stringField(message, "type"), stringField(message, "requestId")
	catalog, err := s.catalog()
	if err != nil {
		return err
	}
	projects := []interface{}{}
	providers := map[string]json.RawMessage{}
	controls := map[string][]wireObject{}
	for _, p := range catalog {
		d, err := p.Discover(s.ctx)
		if err != nil {
			slog.Warn("skipping unavailable project profile", "profile", p.Profile, "reason", err.Error())
			continue
		}
		if d.Project != nil {
			project := d.Project
			projects = append(projects, map[string]interface{}{"projectId": project.ID, "projectDisplayName": project.Name, "projectRootPath": project.Root, "projectKind": "git"})
		}
		for _, entry := range d.Providers {
			var item wireObject
			if json.Unmarshal(entry, &item) == nil {
				providers[stringField(item, "provider")] = entry
			}
		}
		for key, value := range d.Controls {
			controls[key] = value
		}
	}
	entries := []json.RawMessage{}
	keys := make([]string, 0, len(providers))
	for name := range providers {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		entries = append(entries, providers[name])
	}
	payload := map[string]interface{}{"requestId": id}
	response := ""
	switch op {
	case "provider.controls.list.request", "list_provider_features_request":
		draft := objectValue(message, "draftConfig")
		provider, model := stringField(draft, "provider"), stringField(draft, "model")
		key, _ := json.Marshal([]string{provider, model})
		items, ok := controls[string(key)]
		if !ok {
			key, _ = json.Marshal([]string{provider, ""})
			items, ok = controls[string(key)]
		}
		if !ok {
			return errors.New("provider controls have not been synced; sync credentials again")
		}
		options := wireObject{}
		overrides := objectValue(draft, "providerOptions")
		features := []interface{}{}
		for _, control := range items {
			key := stringField(control, "key")
			value := control["defaultValue"]
			if override, exists := overrides[key]; exists {
				value = override
			}
			if len(value) > 0 {
				options[key] = value
			}
			feature := map[string]interface{}{"type": stringField(control, "type"), "id": key, "label": stringField(control, "label")}
			if len(value) > 0 {
				feature["value"] = json.RawMessage(value)
			}
			if stringField(control, "type") == "select" {
				var choices []wireObject
				_ = json.Unmarshal(control["choices"], &choices)
				values := []interface{}{}
				for _, choice := range choices {
					values = append(values, map[string]string{"id": stringField(choice, "value"), "label": stringField(choice, "label")})
				}
				feature["options"] = values
			}
			features = append(features, feature)
		}
		payload["provider"] = provider
		payload["fetchedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
		if op == "provider.controls.list.request" {
			response = "provider.controls.list.response"
			if items == nil {
				items = []wireObject{}
			}
			payload["controls"] = items
			payload["options"] = options
		} else {
			response = "list_provider_features_response"
			payload["features"] = features
		}
	case "project.list.request":
		response = "project.list.response"
		payload["projects"] = projects
	case "get_providers_snapshot_request":
		response = "get_providers_snapshot_response"
		payload["entries"] = entries
		payload["generatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	case "list_available_providers_request":
		response = "list_available_providers_response"
		available := []interface{}{}
		for _, raw := range entries {
			var item wireObject
			_ = json.Unmarshal(raw, &item)
			available = append(available, map[string]interface{}{"provider": stringField(item, "provider"), "available": stringField(item, "status") == "ready"})
		}
		payload["providers"] = available
		payload["fetchedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	case "list_provider_models_request", "list_provider_modes_request":
		provider := stringField(message, "provider")
		var item wireObject
		_ = json.Unmarshal(providers[provider], &item)
		if item == nil {
			return errors.New("provider credentials and model catalog have not been synced")
		}
		payload["provider"] = provider
		payload["fetchedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
		if op == "list_provider_models_request" {
			response = "list_provider_models_response"
			var models []json.RawMessage
			_ = json.Unmarshal(item["models"], &models)
			if models == nil {
				models = []json.RawMessage{}
			}
			payload["models"] = models
		} else {
			response = "list_provider_modes_response"
			var modes []json.RawMessage
			_ = json.Unmarshal(item["modes"], &modes)
			if modes == nil {
				modes = []json.RawMessage{}
			}
			payload["modes"] = modes
		}
	case "get_daemon_config_request":
		response = "get_daemon_config_response"
		payload["config"] = map[string]interface{}{"mcp": map[string]bool{"injectIntoAgents": false}}
	case "hosts.list.request":
		response = "hosts.list.response"
		payload["directory"] = map[string]interface{}{"self": map[string]string{"serverId": s.options.ServerID, "label": s.options.Hostname}, "hosts": []interface{}{}}
	default:
		return errors.New("unsupported host request")
	}
	out, err := sessionFrame(map[string]interface{}{"type": response, "payload": payload})
	if err != nil {
		return err
	}
	return s.emit(out)
}

func (s *Session) deleteEnvironment(name string) error {
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(controller.GVK)
	if err := s.options.Provisioner.Client.Get(s.ctx, types.NamespacedName{Name: name, Namespace: s.options.Provisioner.Namespace}, obj); err != nil {
		return client.IgnoreNotFound(err)
	}
	if obj.GetAnnotations()[requestAnnotation] == "" {
		return errors.New("environment is not managed by the gateway")
	}
	return client.IgnoreNotFound(s.options.Provisioner.Client.Delete(s.ctx, obj))
}
