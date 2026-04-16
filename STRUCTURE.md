# Nerve Project Structure

- `core/`: Rust implementation for SIMD-accelerated keyword scoring.
  - `src/lib.rs`: FFI-exposed `process_query` and `mmap_load_database`.
- `db/`: Storage for the binary Write-Ahead-Log.
  - `changes.log.bin`: Append-only log of keyword assignments. Memory-mapped for high-performance loading and persistence.
- `src/`: Bun main process and logic.
  - `engine.ts`: Core logic, FFI wrapper, and database management.
  - `index.ts`: Electrobun entry point and window setup.
  - `types.ts`: Shared RPC schema for communication between Bun and Webview.
  - `ui/`: Frontend assets.
    - `index.html`: Main UI template.
    - `main.ts`: Frontend logic and interaction handling.
- `test/`: Testing suite.
  - `perf_test.ts`: High-performance benchmark for the search engine.
- `electrobun.config.ts`: Configuration for app bundling and views.
- `Makefile`: Build automation.
- `run.sh`: Brutalist automation script for build and dev.
- `package.json`: Project configuration and dependencies.
