package gateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const CatalogName = "paseo-workspaces-gateway"

type ProfileConfiguration struct {
	Profile        string `json:"profile"`
	Image          string `json:"image"`
	Docker         bool   `json:"docker"`
	Ephemeral      bool   `json:"ephemeral"`
	MainConnection string `json:"mainConnection,omitempty"`
}
type Catalog struct {
	Client    client.Client
	Namespace string
}

func (c Catalog) Load(ctx context.Context) ([]*Provisioner, error) {
	var config corev1.ConfigMap
	if err := c.Client.Get(ctx, types.NamespacedName{Name: CatalogName, Namespace: c.Namespace}, &config); err != nil {
		if apierrors.IsNotFound(err) {
			return []*Provisioner{}, nil
		}
		return nil, err
	}
	if config.Labels["workspaces.paseo.sh/profile-owner"] == "" {
		return nil, errors.New("gateway configuration is not owned by the companion")
	}
	var entries []ProfileConfiguration
	if json.Unmarshal([]byte(config.Data["projects.json"]), &entries) != nil || len(entries) > 100 {
		return nil, errors.New("gateway project catalog is invalid")
	}
	result := make([]*Provisioner, 0, len(entries))
	for _, entry := range entries {
		if entry.Profile == "" || entry.Image == "" {
			return nil, errors.New("gateway profile or workspace image is missing")
		}
		result = append(result, &Provisioner{Client: c.Client, Namespace: c.Namespace, Profile: entry.Profile, Image: entry.Image, Docker: entry.Docker, Persistent: !entry.Ephemeral, MainConnection: entry.MainConnection})
	}
	return result, nil
}

// EnsureIdentity persists the virtual host's identity across operator rolls.
// The companion reads this Secret on the main daemon; its UI never sees it.
func EnsureIdentity(ctx context.Context, c client.Client, namespace string) (serverID, password string, err error) {
	key := types.NamespacedName{Name: controller.GatewayAuthSecret, Namespace: namespace}
	var secret corev1.Secret
	if err = c.Get(ctx, key, &secret); apierrors.IsNotFound(err) {
		bytes := make([]byte, 48)
		if _, err = rand.Read(bytes); err != nil {
			return "", "", err
		}
		immutable := true
		secret = corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "paseo-workspaces-operator"}}, Immutable: &immutable, Data: map[string][]byte{"serverId": []byte(randomID()), "password": []byte(base64.RawURLEncoding.EncodeToString(bytes))}}
		if err = c.Create(ctx, &secret); apierrors.IsAlreadyExists(err) {
			err = c.Get(ctx, key, &secret)
		}
	}
	if err != nil {
		return "", "", err
	}
	if secret.Labels["app.kubernetes.io/managed-by"] != "paseo-workspaces-operator" || len(secret.Data["password"]) < 32 || len(secret.Data["serverId"]) == 0 {
		return "", "", errors.New("gateway identity Secret is invalid or unmanaged")
	}
	return string(secret.Data["serverId"]), string(secret.Data["password"]), nil
}
