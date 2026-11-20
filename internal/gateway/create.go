package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
)

const creationPodAnnotation = "workspaces.paseo.sh/creation-pod-uid"

type WorkspaceBackend interface {
	SendText([]byte) error
	Receive() (Frame, error)
	Close() error
}

// Creator coordinates one creation intent. The caller retains the connected
// backend on success and must deliver the captured events before reading more.
type Creator struct {
	Provisioner  *Provisioner
	ClientID     string
	Password     string
	PollInterval time.Duration
	Dial         func(context.Context, string, string, string) (WorkspaceBackend, error)
	Wait         func(context.Context, string) (string, error)
}

type CreatedWorkspace struct {
	Environment string
	Backend     WorkspaceBackend
	Events      []Frame
	Response    Frame
}

func (c *Creator) Create(ctx context.Context, input Frame) (result CreatedWorkspace, err error) {
	if c.Provisioner == nil || c.ClientID == "" || input.Binary {
		return result, errors.New("workspace creator is not configured")
	}
	var request struct {
		Type    string `json:"type"`
		Message struct {
			Type           string `json:"type"`
			RequestID      string `json:"requestId"`
			IdempotencyKey string `json:"idempotencyKey"`
			WorkspaceID    string `json:"workspaceId"`
			Agent          *struct {
				Config struct {
					Provider string `json:"provider"`
				} `json:"config"`
			} `json:"agent"`
		} `json:"message"`
	}
	if json.Unmarshal(input.Data, &request) != nil || request.Type != "session" || request.Message.Type != "workspace.create.request" || request.Message.RequestID == "" {
		return result, errors.New("invalid workspace creation request")
	}
	discovery, err := c.Provisioner.Discover(ctx)
	if err != nil {
		return result, err
	}
	if discovery.Project == nil {
		return result, errors.New("sync an approved repository before creating a workspace")
	}
	translated, err := PrepareCreate(input.Data, discovery.Project.ID, discovery.Project.Root)
	if err != nil {
		return result, err
	}
	provider := ""
	if request.Message.Agent != nil {
		provider = request.Message.Agent.Config.Provider
		if provider == "" {
			return result, errors.New("initial agent provider is missing")
		}
	}
	key := request.Message.IdempotencyKey
	if key == "" {
		key = request.Message.WorkspaceID
	}
	if key == "" {
		key = request.Message.RequestID
	}
	resource, err := c.Provisioner.CreateWithRequirements(ctx, key, Requirements{Provider: provider, Repository: discovery.Project.Repository})
	if err != nil {
		return result, err
	}
	result.Environment = resource.GetName()
	var endpoint string
	if c.Wait != nil {
		endpoint, err = c.Wait(ctx, result.Environment)
	} else {
		interval := c.PollInterval
		if interval <= 0 {
			interval = time.Second
		}
		endpoint, err = c.Provisioner.WaitReady(ctx, result.Environment, interval)
	}
	if err != nil {
		return result, err
	}
	expected := fmt.Sprintf("pw-%s.%s.svc:6767", result.Environment, c.Provisioner.Namespace)
	if endpoint != expected {
		return result, errors.New("workspace daemon endpoint does not match its Kubernetes Service")
	}
	current := &unstructured.Unstructured{}
	current.SetGroupVersionKind(controller.GVK)
	if err := c.Provisioner.Client.Get(ctx, types.NamespacedName{Namespace: c.Provisioner.Namespace, Name: result.Environment}, current); err != nil {
		return result, err
	}
	podUID, _, _ := unstructured.NestedString(current.Object, "status", "podUID")
	if podUID == "" {
		return result, errors.New("workspace pod identity is not available")
	}
	// Persist the attempt before sending a prompt. A replacement ephemeral pod
	// must never replay an intent whose outcome on the old pod is unknown.
	if err := c.claimPod(ctx, result.Environment, podUID); err != nil {
		return result, err
	}
	dial := c.Dial
	if dial == nil {
		dial = func(ctx context.Context, endpoint, clientID, password string) (WorkspaceBackend, error) {
			return DialBackend(ctx, endpoint, clientID, password)
		}
	}
	backend, err := dial(ctx, endpoint, c.ClientID, c.Password)
	if err != nil {
		return result, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = backend.Close()
		}
	}()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			_ = backend.Close()
		case <-stop:
		}
	}()
	if err := backend.SendText(translated); err != nil {
		return result, fmt.Errorf("send workspace creation: %w", err)
	}
	total := 0
	for len(result.Events) < 1000 {
		frame, err := backend.Receive()
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			return result, fmt.Errorf("receive workspace creation: %w", err)
		}
		total += len(frame.Data)
		if total > 16*1024*1024 {
			return result, errors.New("workspace creation events exceed buffer limit")
		}
		var response struct {
			Type    string `json:"type"`
			Message struct {
				Type    string `json:"type"`
				Payload struct {
					RequestID string  `json:"requestId"`
					Error     *string `json:"error"`
				} `json:"payload"`
			} `json:"message"`
		}
		if !frame.Binary && json.Unmarshal(frame.Data, &response) == nil && response.Type == "session" && response.Message.Type == "workspace.create.response" && response.Message.Payload.RequestID == request.Message.RequestID {
			if response.Message.Payload.Error != nil {
				result.Response = frame
				return result, nil
			}
			if err := c.Provisioner.ObserveCreation(ctx, result.Environment, podUID, request.Message.RequestID, frame.Data); err != nil {
				return result, err
			}
			result.Response, err = TranslateCreationFrame(frame, result.Environment, *discovery.Project)
			if err != nil {
				return result, err
			}
			result.Backend = backend
			keep = true
			return result, nil
		}
		result.Events = append(result.Events, frame)
	}
	return result, errors.New("workspace creation emitted too many events")
}

func (c *Creator) claimPod(ctx context.Context, name, podUID string) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(controller.GVK)
		if err := c.Provisioner.Client.Get(ctx, types.NamespacedName{Namespace: c.Provisioner.Namespace, Name: name}, obj); err != nil {
			return err
		}
		actual, _, _ := unstructured.NestedString(obj.Object, "status", "podUID")
		phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
		if actual != podUID || phase != "Ready" {
			return errors.New("workspace pod changed before creation")
		}
		annotations := obj.GetAnnotations()
		previous := annotations[creationPodAnnotation]
		if previous != "" && previous != podUID {
			return errors.New("workspace pod was replaced after creation started; outcome is unknown")
		}
		if previous == podUID {
			return nil
		}
		annotations[creationPodAnnotation] = podUID
		obj.SetAnnotations(annotations)
		return c.Provisioner.Client.Update(ctx, obj)
	})
}
