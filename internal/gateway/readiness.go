package gateway

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

// DefaultPendingGrace is how long a Pending reason may persist before WaitReady reports it.
const DefaultPendingGrace = 15 * time.Second

// WaitReady waits for the controller to report a ready daemon. Cancellation
// does not delete the workspace: the same request can safely be resumed.
func (p *Provisioner) WaitReady(ctx context.Context, name string, interval time.Duration) (string, error) {
	if interval <= 0 {
		return "", errors.New("poll interval must be positive")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	grace := p.PendingGrace
	if grace == 0 {
		grace = DefaultPendingGrace
	}
	start := time.Now()
	for {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := p.Client.Get(ctx, types.NamespacedName{Namespace: p.Namespace, Name: name}, obj); err != nil {
			return "", fmt.Errorf("read workspace: %w", err)
		}
		if obj.GetDeletionTimestamp() != nil {
			return "", errors.New("workspace is being deleted")
		}
		phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
		message, _, _ := unstructured.NestedString(obj.Object, "status", "message")
		endpoint, _, _ := unstructured.NestedString(obj.Object, "status", "endpoint")
		switch phase {
		case "Ready":
			if endpoint == "" {
				return "", errors.New("ready workspace has no daemon endpoint")
			}
			return endpoint, nil
		case "Failed":
			return "", fmt.Errorf("workspace provisioning failed: %s", message)
		case "Pending":
			// Surface an actionable reason (quota, scheduling, storage) once it persists.
			if controller.IsPendingReason(message) && time.Since(start) >= grace {
				return "", fmt.Errorf("workspace pending: %s", message)
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}
	}
}
