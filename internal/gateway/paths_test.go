package gateway

import "testing"

func TestWorkspacePathsAreDistinctAndRoundTrip(t *testing.T) {
	a, err := VirtualizePath("first", "/workspace/repository/src/file.ts")
	if err != nil {
		t.Fatal(err)
	}
	b, err := VirtualizePath("second", "/workspace/repository/src/file.ts")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("workspace paths collided")
	}
	env, real, err := ParseVirtualPath(a)
	if err != nil || env != "first" || real != "/workspace/repository/src/file.ts" {
		t.Fatalf("%s %s %v", env, real, err)
	}
}

func TestRejectUnsafeVirtualPaths(t *testing.T) {
	for _, value := range []string{"/__paseo_kubernetes/first/workspace/../../etc/passwd", "/__paseo_kubernetes/first/workspace/./x", "/__paseo_kubernetes/first/etc/passwd", "/workspace/repository"} {
		if _, _, err := ParseVirtualPath(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	for _, value := range []string{"/workspace/../etc", "/home/user", "relative"} {
		if _, err := VirtualizePath("first", value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
