package gateway

import (
	"errors"
	"path"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

const virtualPathRoot = "/__paseo_kubernetes"

// VirtualizePath gives identical in-pod workspace paths distinct host-visible
// paths. Only known path fields should be translated, never arbitrary text.
func VirtualizePath(environment, real string) (string, error) {
	if len(environment) > 50 || len(validation.IsDNS1123Label(environment)) != 0 {
		return "", errors.New("invalid workspace environment")
	}
	if !path.IsAbs(real) || path.Clean(real) != real || (real != "/workspace" && !strings.HasPrefix(real, "/workspace/")) {
		return "", errors.New("path is outside the workspace")
	}
	return virtualPathRoot + "/" + environment + real, nil
}

// ParseVirtualPath returns the environment and in-pod path. It refuses
// traversal and non-canonical spellings rather than normalizing them.
func ParseVirtualPath(virtual string) (environment, real string, err error) {
	if !path.IsAbs(virtual) || path.Clean(virtual) != virtual || !strings.HasPrefix(virtual, virtualPathRoot+"/") {
		return "", "", errors.New("invalid virtual workspace path")
	}
	rest := strings.TrimPrefix(virtual, virtualPathRoot+"/")
	idx := strings.IndexByte(rest, '/')
	if idx < 0 {
		return "", "", errors.New("invalid virtual workspace path")
	}
	environment, real = rest[:idx], rest[idx:]
	canonical, err := VirtualizePath(environment, real)
	if err != nil || canonical != virtual {
		return "", "", errors.New("invalid virtual workspace path")
	}
	return environment, real, nil
}
