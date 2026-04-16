# Nerve Makefile

all: build-core

build-core:
	@./run.sh

test-perf:
	@./run.sh test

clean:
	rm -rf core/target
	rm -rf db/*.bin
	rm -rf out

.PHONY: all build-core test-perf clean
