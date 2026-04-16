#!/bin/bash
# Nerve - Brutalist Arch Automation Script

set -e

# 1. Build Rust Core
echo "--- Building Rust Core (SIMD & LSM-Tree) ---"
cd core
RUSTFLAGS="-C target-cpu=native" cargo build --release
cd ..

# 2. Run Performance Test or App
if [ "$1" == "test" ]; then
    echo "--- Running Performance Benchmark ---"
    bun test/perf_test.ts
else
    echo "--- Starting Nerve Engine (Electrobun Dev) ---"
    # Disable GPU acceleration to fix common WebKitGTK rendering issues on Linux
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
    bunx electrobun dev
fi
