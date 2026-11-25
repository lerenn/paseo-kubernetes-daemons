package gateway

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

type setOptions struct {
	owner, setOwner string
	setKind         string
	mutable         bool
	skipSet         bool
	bootstrap       string
	profiles        bool
}

func providerScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	scheme.AddKnownTypeWithName(controller.GVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"), &unstructured.UnstructuredList{})
	return scheme
}

// providerObjects builds a project profile ("project") paired with a provider set ("set").
func providerObjects(o setOptions) []client.Object {
	if o.owner == "" {
		o.owner = "owner"
	}
	if o.setOwner == "" {
		o.setOwner = o.owner
	}
	if o.setKind == "" {
		o.setKind = "providers"
	}
	if o.bootstrap == "" {
		o.bootstrap = `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true}`
	}
	immutable := !o.mutable
	meta := func(name, owner, kind string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: "workspaces", Labels: map[string]string{ownerLabel: owner, kindLabel: kind}}
	}
	objects := []client.Object{
		&corev1.Secret{ObjectMeta: meta("project", o.owner, "project"), Immutable: &immutable, Data: map[string][]byte{"files.json": []byte(`{"config.toml":""}`)}},
		&corev1.Secret{ObjectMeta: meta("project-env", o.owner, "project"), Immutable: &immutable},
		&corev1.ConfigMap{ObjectMeta: meta("project", o.owner, "project"), Immutable: &immutable, Data: map[string]string{"bootstrap.json": o.bootstrap}},
	}
	if !o.skipSet {
		objects = append(objects,
			&corev1.Secret{ObjectMeta: meta("set", o.setOwner, o.setKind), Immutable: &immutable, Data: map[string][]byte{"files.json": []byte(`{"config.toml":"","auth.json":"{\"tokens\":{\"access_token\":\"x\"}}",".credentials.json":"{}"}`)}},
			&corev1.Secret{ObjectMeta: meta("set-env", o.setOwner, o.setKind), Immutable: &immutable, Data: map[string][]byte{"OPENAI_API_KEY": []byte("k"), "GITHUB_TOKEN": []byte("g"), "DOCS_TOKEN": []byte("d"), "OTHER_TOKEN": []byte("o")}},
			&corev1.ConfigMap{ObjectMeta: meta("set", o.setOwner, o.setKind), Immutable: &immutable, Data: map[string]string{"providers.json": `{"providers":["codex-login","openai-key","github-token"],"mcps":["docs","other"],"mcpEnv":{"docs":["DOCS_TOKEN"],"other":["OTHER_TOKEN"]},"providerSnapshot":[{"provider":"codex"}],"providerControls":{}}`}})
	}
	if o.profiles {
		for _, obj := range objects {
			switch v := obj.(type) {
			case *corev1.Secret:
				if v.Name == "set" {
					v.Data["files.json"] = []byte(`{"config.toml":"","paseo-providers.json":"{}"}`)
				}
			case *corev1.ConfigMap:
				if v.Name == "set" {
					v.Data["providers.json"] = `{"providers":["profile:codex-proxy","profile:other"],"mcps":[],"mcpEnv":{},"providerSnapshot":[],"providerControls":{}}`
				}
			}
		}
	}
	return objects
}

func providerFixture(t *testing.T, o setOptions, funcs ...interceptor.Funcs) *Provisioner {
	t.Helper()
	builder := fake.NewClientBuilder().WithScheme(providerScheme(t)).WithObjects(providerObjects(o)...)
	if len(funcs) > 0 {
		builder = builder.WithInterceptorFuncs(funcs[0])
	}
	return &Provisioner{Client: builder.Build(), Namespace: "workspaces", Image: "workspace:v1", Profile: "project", Providers: "set"}
}

func stringsAt(t *testing.T, obj *unstructured.Unstructured, field string) []string {
	t.Helper()
	list, _, err := unstructured.NestedStringSlice(obj.Object, "spec", "bootstrap", "providers", field)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func TestCreateWithProviderSetWritesAllNarrowedLists(t *testing.T) {
	p := providerFixture(t, setOptions{})
	obj, err := p.CreateWithRequirements(context.Background(), "r", Requirements{Provider: "codex", Repository: "https://example.com/a/b", MCPs: []string{"docs"}})
	if err != nil {
		t.Fatal(err)
	}
	// No subset in the project: "all" is the full explicit list, not an absent field.
	if got := strings.Join(stringsAt(t, obj, "envKeys"), ","); got != "DOCS_TOKEN,GITHUB_TOKEN,OPENAI_API_KEY,OTHER_TOKEN" {
		t.Fatalf("envKeys %q", got)
	}
	if got := strings.Join(stringsAt(t, obj, "files"), ","); got != ".credentials.json,auth.json" {
		t.Fatalf("files %q", got)
	}
	if got := strings.Join(stringsAt(t, obj, "mcps"), ","); got != "docs,other" {
		t.Fatalf("mcps %q", got)
	}
	if name, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "providers", "secretName"); name != "set" {
		t.Fatalf("provider set %q", name)
	}
	if name, _, _ := unstructured.NestedString(obj.Object, "spec", "bootstrap", "secretName"); name != "project" {
		t.Fatalf("project profile %q", name)
	}
}

func TestProviderSubsetNarrowsGatesAndLists(t *testing.T) {
	p := providerFixture(t, setOptions{bootstrap: `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true,"providers":["openai-key"],"mcps":["docs"],"projectMcps":["local"]}`})
	ctx := context.Background()
	if _, err := p.CreateWithRequirements(ctx, "a", Requirements{Provider: "claude"}); err == nil {
		t.Fatal("provider outside the set accepted")
	}
	if _, err := p.CreateWithRequirements(ctx, "a", Requirements{MCPs: []string{"other"}}); err == nil {
		t.Fatal("MCP outside the subset accepted")
	}
	obj, err := p.CreateWithRequirements(ctx, "a", Requirements{Provider: "codex", MCPs: []string{"docs", "local"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stringsAt(t, obj, "envKeys"), ","); got != "DOCS_TOKEN,OPENAI_API_KEY" {
		t.Fatalf("envKeys %q", got)
	}
	// codex-login is not selected, so its login file and the OAuth cache-less subset stay out.
	if got := strings.Join(stringsAt(t, obj, "files"), ","); got != ".credentials.json" {
		t.Fatalf("files %q", got)
	}
	if got := strings.Join(stringsAt(t, obj, "mcps"), ","); got != "docs" {
		t.Fatalf("mcps %q", got)
	}
}

func TestEmptySubsetMeansNone(t *testing.T) {
	p := providerFixture(t, setOptions{bootstrap: `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true,"providers":[],"mcps":[]}`})
	obj, err := p.Create(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"envKeys", "files", "mcps"} {
		if got := stringsAt(t, obj, field); len(got) != 0 {
			t.Fatalf("%s %v", field, got)
		}
	}
	if _, err := p.CreateWithRequirements(context.Background(), "b", Requirements{Provider: "codex"}); err == nil {
		t.Fatal("empty subset must grant no provider")
	}
}

func TestSubsetOutsideSetIsRejected(t *testing.T) {
	p := providerFixture(t, setOptions{bootstrap: `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true,"providers":["anthropic-key"]}`})
	if _, err := p.Create(context.Background(), "a"); err == nil {
		t.Fatal("subset naming a provider outside the set accepted")
	}
}

func TestSixObjectCoOwnership(t *testing.T) {
	for name, o := range map[string]setOptions{
		"other owner": {setOwner: "stranger"},
		"wrong kind":  {setKind: "project"},
		"mutable":     {mutable: true},
		"missing set": {skipSet: true},
	} {
		p := providerFixture(t, o)
		if _, err := p.Create(context.Background(), "a"); err == nil {
			t.Fatalf("%s accepted", name)
		}
		list := &unstructured.UnstructuredList{}
		list.SetGroupVersionKind(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"))
		if err := p.Client.List(context.Background(), list); err != nil || len(list.Items) != 0 {
			t.Fatalf("%s created a workspace", name)
		}
	}
}

func TestCRDSkewGuard(t *testing.T) {
	prune := interceptor.Funcs{Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			// An old CRD prunes the unknown field.
			unstructured.RemoveNestedField(u.Object, "spec", "bootstrap", "providers")
		}
		return c.Create(ctx, obj, opts...)
	}}
	p := providerFixture(t, setOptions{}, prune)
	_, err := p.Create(context.Background(), "a")
	if err == nil || !strings.Contains(err.Error(), "CRD out of date") {
		t.Fatalf("error %v", err)
	}
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(controller.GVK.GroupVersion().WithKind("PaseoWorkspaceList"))
	if err := p.Client.List(context.Background(), list); err != nil || len(list.Items) != 0 {
		t.Fatal("the credential-less workspace must be removed")
	}
}

func TestExistingComparesProviderSet(t *testing.T) {
	p := providerFixture(t, setOptions{})
	if _, err := p.Create(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Create(context.Background(), "a"); err != nil {
		t.Fatalf("retry: %v", err)
	}
	p.Providers = "other-set"
	if _, err := p.Create(context.Background(), "a"); err == nil {
		t.Fatal("retry with a different provider set must conflict")
	}
}

func TestDiscoverReadsProviderSet(t *testing.T) {
	p := providerFixture(t, setOptions{})
	d, err := p.Discover(context.Background())
	if err != nil || d.Project == nil || d.Project.Name != "b" || len(d.Providers) != 1 {
		t.Fatalf("discovery %+v err %v", d, err)
	}
	foreign := providerFixture(t, setOptions{setOwner: "stranger"})
	if _, err := foreign.Discover(context.Background()); err == nil {
		t.Fatal("foreign provider set accepted")
	}
	missing := providerFixture(t, setOptions{skipSet: true})
	if _, err := missing.Discover(context.Background()); err == nil {
		t.Fatal("missing provider set accepted")
	}
}

func TestTargetsUseTheWorkspacesOwnProviderSet(t *testing.T) {
	p := providerFixture(t, setOptions{})
	ctx := context.Background()
	obj, err := p.Create(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	routes, _ := json.Marshal(Routes{PodUID: "uid"})
	annotations := obj.GetAnnotations()
	annotations[routesAnnotation] = string(routes)
	obj.SetAnnotations(annotations)
	obj.Object["status"] = map[string]interface{}{"phase": "Ready", "podUID": "uid"}
	if err := p.Client.Update(ctx, obj); err != nil {
		t.Fatal(err)
	}
	// The catalog entry changed to another provider set; the running workspace keeps its own.
	base := &Provisioner{Client: p.Client, Namespace: p.Namespace}
	targets, err := base.Targets(ctx)
	if err != nil || len(targets) != 1 || targets[0].Project.Name != "b" {
		t.Fatalf("targets %+v err %v", targets, err)
	}
}

func TestBrokenEntriesAreSkipped(t *testing.T) {
	entries := []ProfileConfiguration{{Profile: "Bad Name!", Image: "i"}, {Profile: "p", Providers: "bad_set", Image: "i"}, {Profile: "ok", Providers: "set", Image: "i"}, {Profile: "legacy", Image: "i"}}
	data, _ := json.Marshal(entries)
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: CatalogName, Namespace: "ns", Labels: map[string]string{ownerLabel: "x"}}, Data: map[string]string{"projects.json": string(data)}}
	got, err := (Catalog{Client: fake.NewClientBuilder().WithObjects(cm).Build(), Namespace: "ns"}).Load(context.Background())
	if err != nil || len(got) != 2 || got[0].Profile != "ok" || got[0].Providers != "set" || got[1].Profile != "legacy" || got[1].Providers != "" {
		t.Fatalf("got %+v err %v", got, err)
	}
}

func TestMultiProfileRoutingSkipsABrokenProject(t *testing.T) {
	good := providerFixture(t, setOptions{})
	broken := &Provisioner{Client: good.Client, Namespace: "workspaces", Image: "i", Profile: "gone", Providers: "set"}
	other := &Provisioner{Client: good.Client, Namespace: "workspaces", Image: "i", Profile: "project", Providers: "missing-set"}
	s := &Session{ctx: context.Background(), options: SessionOptions{Catalog: func(context.Context) ([]*Provisioner, error) {
		return []*Provisioner{broken, other, good}, nil
	}}}
	d := Discovery{}
	p, d, err := s.discovery("")
	if err != nil || p != good || d.Project == nil {
		t.Fatalf("routed to %+v err %v", p, err)
	}
	p, d, err = s.discovery(d.Project.ID)
	if err != nil || p != good {
		t.Fatalf("project id routed to %+v err %v", p, err)
	}
	if _, _, err := s.discovery("prj_unknown"); err == nil {
		t.Fatal("unknown project must fail")
	}
}

// The golden file is generated by the plugin's catalog writer (plugin/server/catalog.test.ts);
// Load must parse exactly what the plugin writes.
func TestCatalogLoadParsesPluginOutput(t *testing.T) {
	golden, err := os.ReadFile("testdata/catalog_plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: CatalogName, Namespace: "ns", Labels: map[string]string{ownerLabel: "x"}}, Data: map[string]string{"projects.json": string(golden)}}
	var raw []map[string]interface{}
	if err := json.Unmarshal(golden, &raw); err != nil || len(raw) < 2 {
		t.Fatalf("golden file must hold at least two entries: %v", err)
	}
	got, err := (Catalog{Client: fake.NewClientBuilder().WithObjects(cm).Build(), Namespace: "ns"}).Load(context.Background())
	if err != nil || len(got) != len(raw) {
		t.Fatalf("Load skipped or failed entries of the plugin catalog: %d of %d, err %v", len(got), len(raw), err)
	}
	for i, p := range got {
		if p.Profile != raw[i]["profile"] || (p.Providers != "") != (raw[i]["providers"] != nil) {
			t.Fatalf("entry %d parsed as %+v from %v", i, p, raw[i])
		}
	}
}

func TestProfileSelectionListsFileAndProfiles(t *testing.T) {
	p := providerFixture(t, setOptions{profiles: true, bootstrap: `{"repository":{"url":"https://example.com/a/b"},"trustRepository":true,"providers":["profile:codex-proxy"]}`})
	ctx := context.Background()
	if _, err := p.CreateWithRequirements(ctx, "a", Requirements{Provider: "codex"}); err == nil {
		t.Fatal("provider without a selected profile accepted")
	}
	obj, err := p.CreateWithRequirements(ctx, "a", Requirements{Provider: "codex-proxy"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stringsAt(t, obj, "files"), ","); got != "paseo-providers.json" {
		t.Fatalf("files %q", got)
	}
	if got := strings.Join(stringsAt(t, obj, "profiles"), ","); got != "codex-proxy" {
		t.Fatalf("profiles %q", got)
	}
	if got := stringsAt(t, obj, "envKeys"); len(got) != 0 {
		t.Fatalf("profile secrets must not become env vars: %v", got)
	}
}
