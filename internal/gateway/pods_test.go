package gateway

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const todaysResources = `{"requests":{"cpu":"250m","memory":"512Mi","ephemeral-storage":"1Gi"},"limits":{"cpu":"2","memory":"4Gi","ephemeral-storage":"4Gi"}}`

func specJSON(t *testing.T, p *Provisioner, key string) map[string]interface{} {
	t.Helper()
	obj, err := p.Create(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	spec, _ := obj.Object["spec"].(map[string]interface{})
	return spec
}

func TestPodDefaultsMatchTodaysSpec(t *testing.T) {
	for _, persistent := range []bool{false, true} {
		p := fixture(t, true)
		p.Persistent = persistent
		spec := specJSON(t, p, "k")
		want := map[string]interface{}{}
		_ = json.Unmarshal([]byte(todaysResources), &want)
		if !reflect.DeepEqual(spec["resources"], want) {
			t.Fatalf("resources %v", spec["resources"])
		}
		storage := "4Gi"
		if persistent {
			storage = "10Gi"
		}
		if spec["storage"] != storage || spec["storageClassName"] != nil {
			t.Fatalf("storage %v class %v", spec["storage"], spec["storageClassName"])
		}
		if !reflect.DeepEqual(spec["docker"], map[string]interface{}{"enabled": false}) {
			t.Fatalf("docker %v", spec["docker"])
		}
	}
}

func TestPodSettingsAreApplied(t *testing.T) {
	p := fixture(t, true)
	p.Persistent = true
	p.Docker = true
	p.Resources = &corev1.ResourceRequirements{
		Requests: corev1.ResourceList{"cpu": resource.MustParse("1"), "memory": resource.MustParse("1Gi"), "ephemeral-storage": resource.MustParse("2Gi")},
		Limits:   corev1.ResourceList{"cpu": resource.MustParse("4"), "memory": resource.MustParse("8Gi"), "ephemeral-storage": resource.MustParse("8Gi")}}
	p.Storage, p.StorageClassName, p.DockerDataSize = "20Gi", "fast", "30Gi"
	p.DockerResources = &corev1.ResourceRequirements{
		Requests: corev1.ResourceList{"cpu": resource.MustParse("500m"), "memory": resource.MustParse("512Mi"), "ephemeral-storage": resource.MustParse("1Gi")},
		Limits:   corev1.ResourceList{"cpu": resource.MustParse("3"), "memory": resource.MustParse("3Gi"), "ephemeral-storage": resource.MustParse("20Gi")}}
	spec := specJSON(t, p, "k")
	limits := spec["resources"].(map[string]interface{})["limits"].(map[string]interface{})
	docker := spec["docker"].(map[string]interface{})
	dockerLimits := docker["resources"].(map[string]interface{})["limits"].(map[string]interface{})
	if limits["cpu"] != "4" || spec["storage"] != "20Gi" || spec["storageClassName"] != "fast" || docker["dataSize"] != "30Gi" || dockerLimits["memory"] != "3Gi" {
		t.Fatalf("spec %v", spec)
	}
}

func TestDockerSettingsIgnoredWhenDockerIsOff(t *testing.T) {
	p := fixture(t, true)
	p.DockerDataSize = "30Gi"
	if d := specJSON(t, p, "k")["docker"]; !reflect.DeepEqual(d, map[string]interface{}{"enabled": false}) {
		t.Fatalf("docker %v", d)
	}
}

func TestExistingWorkspaceIgnoresPodSettings(t *testing.T) {
	p := fixture(t, true)
	first := specJSON(t, p, "k")
	p.Storage, p.StorageClassName = "50Gi", "other"
	p.Resources = defaultResources()
	p.Resources.Limits["cpu"] = resource.MustParse("8")
	again := specJSON(t, p, "k")
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("retry changed the workspace: %v vs %v", first, again)
	}
}

func TestCatalogSkipsInvalidPodSettings(t *testing.T) {
	good := `{"profile":"good","image":"i","resources":` + todaysResources + `,"storage":"8Gi","storageClassName":"fast"}`
	bad := []string{
		`{"profile":"badquantity","image":"i","resources":{"requests":{"cpu":"lots","memory":"1Gi","ephemeral-storage":"1Gi"},"limits":{"cpu":"2","memory":"1Gi","ephemeral-storage":"1Gi"}}}`,
		`{"profile":"requestabove","image":"i","resources":{"requests":{"cpu":"4","memory":"1Gi","ephemeral-storage":"1Gi"},"limits":{"cpu":"2","memory":"1Gi","ephemeral-storage":"1Gi"}}}`,
		`{"profile":"missingpair","image":"i","resources":{"requests":{"cpu":"1"},"limits":{"cpu":"2"}}}`,
		`{"profile":"tiny","image":"i","storage":"500Mi"}`,
		`{"profile":"badclass","image":"i","storageClassName":"Not Valid"}`,
		`{"profile":"baddocker","image":"i","docker":true,"dockerDataSize":"abc"}`,
	}
	data := "[" + bad[0] + "," + good
	for _, b := range bad[1:] {
		data += "," + b
	}
	data += "]"
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: CatalogName, Namespace: "ns", Labels: map[string]string{ownerLabel: "x"}}, Data: map[string]string{"projects.json": data}}
	got, err := (Catalog{Client: fake.NewClientBuilder().WithObjects(cm).Build(), Namespace: "ns"}).Load(context.Background())
	if err != nil || len(got) != 1 || got[0].Profile != "good" || got[0].Storage != "8Gi" || got[0].Resources == nil {
		t.Fatalf("got %+v err %v", got, err)
	}
}
