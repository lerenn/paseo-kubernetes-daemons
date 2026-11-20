test:
	go test ./...
	python3 -m unittest discover -s images/workspace/tests -v
	cd plugin && npm ci && npm run typecheck && npm test
build:
	go build -o bin/operator ./cmd/operator
chart-crd:
	cp config/crd.yaml charts/paseo-workspaces/crds/paseoworkspaces.yaml
