# Nerve Bun (FFI Adapter)

This package contains the Bun FFI wrapper and `NerveAdapter` for the `nerve-core` Rust engine.

## Installation for Superbun

In `superbun/package.json`, add the dependency:

```json
{
  "dependencies": {
    "nerve-bun": "file:../nerve/packages/nerve-bun"
  }
}
```

Then in `superbun/src/Database/NerveAdapter.ts` (or wherever it is used):

```ts
import { NerveAdapter, NerveMatch } from "nerve-bun";

const adapter = new NerveAdapter("db/ai");
const results = adapter.search(["keyword"], [], 10); // Now supports configurable top-K
```

## Features added:
- Configurable `topK` in `search(keywords, exclude, topK)`
- Lowercase keyword normalization by default
- Atomic writes for `sorted.bin` merging
- Fixed log format mismatch
