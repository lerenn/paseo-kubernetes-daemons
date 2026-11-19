test:
	go test ./...
	cd plugin && npm ci && npm run typecheck && npm test
build:
	go build -o bin/operator ./cmd/operator
