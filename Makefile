# Makefile for Nerve

all: build-core build-ui

build-core:
	cd core && cargo build --release

build-ui:
	# Hier könnten zusätzliche Build-Schritte für das UI stehen (z.B. Vite, etc.)
	# Aber für dieses Projekt nutzen wir Vanilla TS/HTML direkt.
	@echo "UI build not required (using vanilla TS/HTML)"

clean:
	rm -rf core/target
	rm -rf db/*.bin
	rm -rf out

test-perf:
	bun test/perf_test.ts

.PHONY: all build-core build-ui clean test-perf
