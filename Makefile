SHELL := /usr/bin/env bash

.PHONY: install typecheck build clean

install:
	bun install

typecheck:
	bun run typecheck

build:
	bun run build

clean:
	rm -rf dist
