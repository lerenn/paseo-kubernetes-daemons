package gateway

import "testing"

func TestAuthorizationFailsClosed(t *testing.T) {
	if err := AuthorizeOperation([]string{"workspace.read"}, "fetch_workspaces_request"); err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeOperation([]string{"hub.execute"}, "agent.create.request"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		scope     []string
		operation string
	}{
		{[]string{"workspace.read"}, "workspace.create.request"},
		{[]string{"workspace.read"}, "fs.file.write.request"},
		{[]string{"daemon.manage", "workspace.manage", "workspace.write", "workspace.read"}, "future.unknown.request"},
		{nil, "fetch_workspaces_request"},
	} {
		if err := AuthorizeOperation(tc.scope, tc.operation); err == nil {
			t.Fatalf("accepted %+v", tc)
		}
	}
}
