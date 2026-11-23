package main

import (
	"flag"
	"github.com/lerenn/paseo-kubernetes-workspaces/internal/controller"
	"github.com/lerenn/paseo-kubernetes-workspaces/internal/gateway"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"strings"
)

func main() {
	var namespace, gatewayAddress, extraHosts, pullSecret, defaultImage string
	flag.StringVar(&namespace, "namespace", "default", "Namespace managed by this operator")
	flag.StringVar(&gatewayAddress, "gateway-listen", "", "Opt-in gateway listen address; empty disables it")
	flag.StringVar(&extraHosts, "gateway-hostnames", "", "Additional comma-separated DNS names accepted by the gateway")
	flag.StringVar(&pullSecret, "workspace-pull-secret", "", "Image pull Secret used by workspace pods")
	flag.StringVar(&defaultImage, "default-workspace-image", "", "Workspace image used by gateway profiles that set none")
	var dockerImage, dockerMirrors string
	var dockerMTU int
	flag.StringVar(&dockerImage, "docker-image", controller.DefaultDockerImage, "Docker-in-Docker sidecar image for workspaces with Docker enabled")
	flag.IntVar(&dockerMTU, "docker-mtu", 1450, "MTU for the Docker sidecar and its default bridge networks; 0 leaves Docker defaults")
	flag.StringVar(&dockerMirrors, "docker-registry-mirror", "", "Comma-separated Docker Hub registry mirrors for the Docker sidecar")
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
	var mirrors []string
	for _, mirror := range strings.Split(dockerMirrors, ",") {
		if strings.TrimSpace(mirror) != "" {
			mirrors = append(mirrors, strings.TrimSpace(mirror))
		}
	}
	if err = (&controller.Reconciler{Client: manager.GetClient(), Namespace: namespace, ImagePullSecret: pullSecret, DockerImage: dockerImage, DockerMTU: dockerMTU, DockerRegistryMirrors: mirrors}).Setup(manager); err != nil {
		ctrl.Log.Error(err, "setup")
		os.Exit(1)
	}
	if gatewayAddress != "" {
		direct, e := client.New(manager.GetConfig(), client.Options{Scheme: scheme})
		if e != nil {
			ctrl.Log.Error(e, "gateway Kubernetes client")
			os.Exit(1)
		}
		hosts := []string{"127.0.0.1", "localhost", "paseo-workspaces-gateway", "paseo-workspaces-gateway." + namespace + ".svc", "paseo-workspaces-gateway." + namespace + ".svc.cluster.local"}
		for _, host := range strings.Split(extraHosts, ",") {
			if strings.TrimSpace(host) != "" {
				hosts = append(hosts, strings.TrimSpace(host))
			}
		}
		if err = manager.Add(&gateway.Runnable{Client: direct, Namespace: namespace, Address: gatewayAddress, Hostname: "Kubernetes", DefaultImage: defaultImage, AllowedHosts: hosts}); err != nil {
			ctrl.Log.Error(err, "gateway setup")
			os.Exit(1)
		}
	}
	if err = manager.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "run")
		os.Exit(1)
	}
}
