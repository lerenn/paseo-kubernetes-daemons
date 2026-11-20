package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type Target struct {
	Name, PodUID, Endpoint, Profile string
	Routes                          Routes
	Project                         Project
}

func (p *Provisioner) Targets(ctx context.Context) ([]Target, error) {
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"))
	if err := p.Client.List(ctx, list, client.InNamespace(p.Namespace)); err != nil {
		return nil, err
	}
	var targets []Target
	for _, obj := range list.Items {
		if obj.GetAnnotations()[requestAnnotation] == "" || obj.GetDeletionTimestamp() != nil {
			continue
		}
		phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
		uid, _, _ := unstructured.NestedString(obj.Object, "status", "podUID")
		if phase != "Ready" || uid == "" {
			continue
		}
		var routes Routes
		raw := obj.GetAnnotations()[routesAnnotation]
		if raw == "" {
			continue
		}
		if json.Unmarshal([]byte(raw), &routes) != nil {
			return nil, errors.New("invalid gateway routing metadata")
		}
		if routes.PodUID != uid {
			continue
		}
		profile, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "configMapName")
		copy := *p
		copy.Profile = profile
		discovery, err := copy.Discover(ctx)
		if err != nil {
			return nil, err
		}
		if discovery.Project == nil {
			continue
		}
		targets = append(targets, Target{Name: obj.GetName(), PodUID: uid, Endpoint: fmt.Sprintf("pw-%s.%s.svc:6767", obj.GetName(), p.Namespace), Profile: profile, Routes: routes, Project: *discovery.Project})
	}
	return targets, nil
}

func messageParts(frame Frame) (wireObject, wireObject, error) {
	if frame.Binary {
		return nil, nil, errors.New("expected session JSON")
	}
	var envelope wireObject
	if json.Unmarshal(frame.Data, &envelope) != nil {
		return nil, nil, errors.New("invalid JSON")
	}
	var kind string
	_ = json.Unmarshal(envelope["type"], &kind)
	if kind != "session" {
		return nil, nil, errors.New("expected session frame")
	}
	var message wireObject
	if json.Unmarshal(envelope["message"], &message) != nil || message == nil {
		return nil, nil, errors.New("invalid session message")
	}
	return envelope, message, nil
}

func stringField(object wireObject, key string) string {
	var value string
	_ = json.Unmarshal(object[key], &value)
	return value
}
func objectValue(object wireObject, key string) wireObject {
	var value wireObject
	_ = json.Unmarshal(object[key], &value)
	return value
}
func encodeMessage(envelope, message wireObject) Frame {
	raw, _ := json.Marshal(message)
	envelope["message"] = raw
	data, _ := json.Marshal(envelope)
	return Frame{Data: data}
}
