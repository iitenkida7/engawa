# engawa task runner
# すべてのアプリコマンドは Docker 経由で実行する

COMPOSE := docker compose

.PHONY: up down restart ps build test install clean

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) down
	$(COMPOSE) up -d

ps:
	$(COMPOSE) ps

build:
	$(COMPOSE) run --rm --no-deps client bun run build

test:
	$(COMPOSE) run --rm --no-deps server bun test
	$(COMPOSE) run --rm --no-deps client bun test

install:
	$(COMPOSE) run --rm --no-deps server bun install
	$(COMPOSE) run --rm --no-deps client bun install

clean:
	$(COMPOSE) down -v
