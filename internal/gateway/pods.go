package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

// Pod settings carried by a catalog entry. Every field is optional: an entry without them yields
// exactly the spec the gateway always produced (the Default* values below).
const (
	defaultEphemeralStorage  = "4Gi"
	defaultPersistentStorage = "10Gi"
)

var storageClassPattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

var podResources = []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory, corev1.ResourceEphemeralStorage}

// defaultResources are the compute settings used when the catalog sets none.
func defaultResources() *corev1.ResourceRequirements {
	return &corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("512Mi"), corev1.ResourceEphemeralStorage: resource.MustParse("1Gi")},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("4Gi"), corev1.ResourceEphemeralStorage: resource.MustParse("4Gi")},
	}
}

// validResources requires a positive cpu, memory and ephemeral-storage pair (the CRD does too) with request <= limit.
func validResources(r *corev1.ResourceRequirements) error {
	for _, name := range podResources {
		request, hasRequest := r.Requests[name]
		limit, hasLimit := r.Limits[name]
		if !hasRequest || !hasLimit {
			return fmt.Errorf("%s needs a request and a limit", name)
		}
		if request.Sign() <= 0 || limit.Sign() <= 0 {
			return fmt.Errorf("%s must be greater than zero", name)
		}
		if request.Cmp(limit) > 0 {
			return fmt.Errorf("%s request exceeds its limit", name)
		}
	}
	return nil
}

// validSize accepts a quantity of at least 1Gi.
func validSize(value string) error {
	q, err := resource.ParseQuantity(value)
	if err != nil {
		return err
	}
	if q.Cmp(resource.MustParse("1Gi")) < 0 {
		return errors.New("size must be at least 1Gi")
	}
	return nil
}

// validPodSettings checks the optional pod settings of a catalog entry; the error names the problem.
func validPodSettings(e ProfileConfiguration) error {
	if e.Resources != nil {
		if err := validResources(e.Resources); err != nil {
			return fmt.Errorf("resources: %w", err)
		}
	}
	if e.DockerResources != nil {
		if err := validResources(e.DockerResources); err != nil {
			return fmt.Errorf("dockerResources: %w", err)
		}
	}
	if e.Storage != "" {
		if err := validSize(e.Storage); err != nil {
			return fmt.Errorf("storage: %w", err)
		}
	}
	if e.DockerDataSize != "" {
		if err := validSize(e.DockerDataSize); err != nil {
			return fmt.Errorf("dockerDataSize: %w", err)
		}
	}
	if e.StorageClassName != "" && (len(e.StorageClassName) > 253 || !storageClassPattern.MatchString(e.StorageClassName)) {
		return errors.New("storageClassName is not a valid name")
	}
	return nil
}

// asMap converts a typed value into the JSON-shaped map an unstructured object needs.
func asMap(v interface{}) map[string]interface{} {
	raw, _ := json.Marshal(v)
	out := map[string]interface{}{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// storageSize is the configured size, or today's literal for the storage mode.
func (p *Provisioner) storageSize() string {
	if p.Storage != "" {
		return p.Storage
	}
	if p.Persistent {
		return defaultPersistentStorage
	}
	return defaultEphemeralStorage
}

func (p *Provisioner) computeResources() map[string]interface{} {
	if p.Resources != nil {
		return asMap(p.Resources)
	}
	return asMap(defaultResources())
}

// dockerSpec is spec.docker. Resources and dataSize are only set when configured, so the controller keeps its own defaults.
func (p *Provisioner) dockerSpec() map[string]interface{} {
	docker := map[string]interface{}{"enabled": p.Docker}
	if p.Docker && p.DockerResources != nil {
		docker["resources"] = asMap(p.DockerResources)
	}
	if p.Docker && p.DockerDataSize != "" {
		docker["dataSize"] = p.DockerDataSize
	}
	return docker
}
