package main

import (
	"flag"
	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
)

func main() {
	var namespace string
	flag.StringVar(&namespace, "namespace", "default", "Namespace managed by this operator")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}, LeaderElection: true, LeaderElectionID: "paseo-workspaces", LeaderElectionNamespace: namespace})
	if err != nil {
		ctrl.Log.Error(err, "manager")
		os.Exit(1)
	}
	if err = (&controller.Reconciler{Client: manager.GetClient(), Namespace: namespace}).Setup(manager); err != nil {
		ctrl.Log.Error(err, "setup")
		os.Exit(1)
	}
	if err = manager.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "run")
		os.Exit(1)
	}
}
