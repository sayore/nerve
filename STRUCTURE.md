# Nerve Project Structure

- `core/`: Rust implementation for SIMD-accelerated keyword scoring.
  - `src/lib.rs`: FFI-exposed ranking function.
- `db/`: Storage for the binary Write-Ahead-Log.
  - `changes.log.bin`: Append-only log of keyword assignments.
- `src/`: Bun main process and logic.
  - `engine.ts`: Core logic, FFI wrapper, and database management.
  - `index.ts`: Electrobun entry point and window setup.
  - `types.ts`: Shared RPC schema for communication between Bun and Webview.
  - `ui/`: Frontend assets.
    - `index.html`: Main UI template.
    - `main.ts`: Frontend logic and interaction handling.
- `test/`: Testing suite.
  - `perf_test.ts`: High-performance benchmark for the search engine.
- `Makefile`: Build automation.
- `package.json`: Project configuration and dependencies.
