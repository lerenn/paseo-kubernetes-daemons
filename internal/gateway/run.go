package gateway

import (
	"context"
	"errors"
	"net/http"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Runnable is only started when the operator is explicitly given a gateway
// listen address. Its credential grants workspace use and discovery, not
// daemon administration, tunnel management, or access management.
type Runnable struct {
	Client                       client.Client
	Namespace, Address, Hostname string
	DefaultImage                 string
	AllowedHosts, AllowedOrigins []string
}

func (r *Runnable) NeedLeaderElection() bool { return true }
func (r *Runnable) Start(ctx context.Context) error {
	id, password, err := EnsureIdentity(ctx, r.Client, r.Namespace)
	if err != nil {
		return err
	}
	catalog := Catalog{Client: r.Client, Namespace: r.Namespace, DefaultImage: r.DefaultImage}
	base := &Provisioner{Client: r.Client, Namespace: r.Namespace}
	permissions := []string{"daemon.read", "workspace.read", "workspace.write", "workspace.manage"}
	handler, err := NewHandler(ServerConfig{Context: ctx, ServerID: id, Hostname: r.Hostname, Version: "0.16.2", Password: password, AllowedHosts: r.AllowedHosts, AllowedOrigins: r.AllowedOrigins, Permissions: permissions, OpenSession: func(ctx context.Context, identity ScopedIdentity, emit func(Frame) error) SessionSink {
		return NewSession(ctx, SessionOptions{ServerID: id, Hostname: r.Hostname, Provisioner: base, Catalog: catalog.Load, Identity: identity, BackendPassword: password, Emit: emit})
	}})
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/ws", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	server := &http.Server{Addr: r.Address, Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 * 1024}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}
