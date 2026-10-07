BIN := bin/go-chamber
GO_TEST := go test -race
FAKE_CLAUDE := bin/fakes/claude
FAKE_CODEX := bin/fakes/codex

.PHONY: all dev build web test test-web cover-gate mutate mutate-go mutate-web lint e2e check clean

all: check

web/node_modules: web/package.json
	cd web && npm install && touch node_modules

web: web/node_modules
	cd web && npm run build

build: web
	go build -tags embedweb -o $(BIN) ./cmd/go-chamber

$(FAKE_CLAUDE): testutil/fakeclaude/main.go
	@mkdir -p $(dir $@)
	go build -o $@ ./testutil/fakeclaude

$(FAKE_CODEX): testutil/fakecodex/main.go
	@mkdir -p $(dir $@)
	go build -o $@ ./testutil/fakecodex

# Two processes: Go backend on :7777 and Vite with HMR proxying /api to it.
dev: web/node_modules
	@trap 'kill 0' EXIT; go run ./cmd/go-chamber & (cd web && npm run dev) & wait

test:
	$(GO_TEST) ./...

test-web: web/node_modules
	cd web && npm run test:cov

cover-gate:
	$(GO_TEST) -coverprofile=coverage.out ./... >/dev/null
	scripts/coverage-gate coverage.out
	$(MAKE) test-web

mutate: mutate-go mutate-web

mutate-go:
	scripts/mutation-gate

mutate-web: web/node_modules
	cd web && npm run mutate

lint: web/node_modules
	golangci-lint run ./...
	cd web && npm run lint && npm run typecheck

e2e: build $(FAKE_CLAUDE) $(FAKE_CODEX) e2e/.installed
	cd e2e && npx playwright test

e2e/.installed: e2e/package.json
	cd e2e && npm install && npx playwright install chromium && touch .installed

# Mutation testing is out of check for now: run alongside parallel agents'
# suites it exhausted the machine's memory. `make mutate` still runs it.
check: lint cover-gate e2e

clean:
	rm -rf bin coverage.out web/dist web/coverage web/reports web/.stryker-tmp e2e/test-results e2e/.data
