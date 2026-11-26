package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lerenn/paseo-kubernetes-daemons/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const routesAnnotation = "daemons.paseo.sh/gateway-routes"

// Routes are observed from a workspace daemon, not accepted from a frontend.
// They are persisted on its workspace resource to survive gateway restarts.
type Routes struct {
	PodUID    string   `json:"podUID"`
	Workspace string   `json:"workspace"`
	Agents    []string `json:"agents,omitempty"`
	Terminals []string `json:"terminals,omitempty"`
}

func validRouteID(id string) bool {
	return len(id) > 0 && len(id) <= 512 && !strings.ContainsAny(id, "\x00\r\n")
}

// SaveRoutes merges observations, refusing to change an environment's
// workspace identity. Optimistic locking avoids losing concurrent additions.
func (p *Provisioner) SaveRoutes(ctx context.Context, name string, seen Routes) error {
	if !validRouteID(seen.Workspace) || !validRouteID(seen.PodUID) {
		return errors.New("invalid workspace or pod identity")
	}
	for _, ids := range [][]string{seen.Agents, seen.Terminals} {
		for _, id := range ids {
			if !validRouteID(id) {
				return errors.New("invalid route identity")
			}
		}
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: name}, obj); err != nil {
			return err
		}
		if obj.GetAnnotations()[requestAnnotation] == "" {
			return errors.New("workspace is not managed by this gateway")
		}
		podUID, _, _ := unstructured.NestedString(obj.Object, "status", "podUID")
		phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
		if phase != "Ready" || podUID != seen.PodUID {
			return errors.New("workspace pod changed or is not ready")
		}
		var current Routes
		if raw := obj.GetAnnotations()[routesAnnotation]; raw != "" {
			if err := json.Unmarshal([]byte(raw), &current); err != nil {
				return errors.New("workspace routing metadata is invalid")
			}
		}
		if current.PodUID != "" && current.PodUID != seen.PodUID {
			current = Routes{}
		}
		if current.Workspace != "" && current.Workspace != seen.Workspace {
			return errors.New("workspace identity changed")
		}
		current.PodUID = seen.PodUID
		current.Workspace = seen.Workspace
		current.Agents = mergeIDs(current.Agents, seen.Agents)
		current.Terminals = mergeIDs(current.Terminals, seen.Terminals)
		data, err := json.Marshal(current)
		if err != nil {
			return err
		}
		if len(data) > 64*1024 {
			return errors.New("workspace routing metadata exceeds limit")
		}
		annotations := obj.GetAnnotations()
		annotations[routesAnnotation] = string(data)
		obj.SetAnnotations(annotations)
		return p.Client.Update(ctx, obj)
	})
}

func mergeIDs(old, added []string) []string {
	set := make(map[string]bool, len(old)+len(added))
	result := make([]string, 0, len(old)+len(added))
	for _, id := range append(old, added...) {
		if !set[id] {
			set[id] = true
			result = append(result, id)
		}
	}
	return result
}

// Resolve looks up an observed identity; ambiguous matches fail closed.
// Service names are computed from resource names, never taken from status.
func (p *Provisioner) Resolve(ctx context.Context, kind, id string) (string, error) {
	if !validRouteID(id) || (kind != "workspace" && kind != "agent" && kind != "terminal") {
		return "", errors.New("invalid route lookup")
	}
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(controller.GVK.GroupVersion().WithKind("PaseoDaemonList"))
	if err := p.Client.List(ctx, list, client.InNamespace(p.Namespace)); err != nil {
		return "", fmt.Errorf("list workspace routes: %w", err)
	}
	var match *unstructured.Unstructured
	for i := range list.Items {
		obj := &list.Items[i]
		if obj.GetAnnotations()[requestAnnotation] == "" || obj.GetDeletionTimestamp() != nil {
			continue
		}
		var routes Routes
		raw := obj.GetAnnotations()[routesAnnotation]
		if raw == "" {
			continue
		}
		if json.Unmarshal([]byte(raw), &routes) != nil {
			return "", errors.New("workspace routing metadata is invalid")
		}
		found := kind == "workspace" && routes.Workspace == id
		if kind == "agent" {
			for _, candidate := range routes.Agents {
				found = found || candidate == id
			}
		}
		if kind == "terminal" {
			for _, candidate := range routes.Terminals {
				found = found || candidate == id
			}
		}
		if found {
			if match != nil {
				return "", errors.New("route identity is ambiguous")
			}
			match = obj
		}
	}
	if match == nil {
		return "", errors.New("workspace route is unknown")
	}
	phase, _, _ := unstructured.NestedString(match.Object, "status", "phase")
	if phase != "Ready" {
		return "", errors.New("workspace daemon is not ready")
	}
	var routes Routes
	if err := json.Unmarshal([]byte(match.GetAnnotations()[routesAnnotation]), &routes); err != nil {
		return "", errors.New("workspace routing metadata is invalid")
	}
	podUID, _, _ := unstructured.NestedString(match.Object, "status", "podUID")
	if podUID == "" || routes.PodUID != podUID {
		return "", errors.New("workspace pod changed; routes require rediscovery")
	}
	return fmt.Sprintf("pw-%s.%s.svc:6767", match.GetName(), p.Namespace), nil
}
