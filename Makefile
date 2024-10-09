include ../include.mk
-include ../local.mk

PORT ?= $(JSONRPC_PROXY_PORT)

export PORT

all:
	@$(npm_path) ; tsc

dev:
	@node $(ts_loader_args) src/index.ts

clean:
	@[[ -d dist ]] && rm -rf dist || :


test:
	@PORT=$(PORT) node test.cjs
