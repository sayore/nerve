# nerve

**Zero-Dependency Semantic Inverted Index & ACID Blob Store for Bun + Rust.**

Sub-10µs top-K tag/keyword intersection engine backed by a `#[repr(C)]` Rust FFI core, L1-resident bitset tombstones, SSE4.2 hardware-CRC32C write-ahead logging, and POSIX atomic `rename` compaction.

---

## Selling Points & Key Statistics

* **Zero Dependencies:** `0` external Rust crates (`std` + raw variadic `libc` syscalls) and `0` npm dependencies (`bun:ffi` + `node:fs`).
* **Ultra-Compact Footprint:** Exactly **`8.0 MB`** on disk for **1,000,000 relations** (`8 bytes/relation`, `#[repr(C)] Pair { id: u32, hash: u32 }`).
* **Sub-10µs Top-K Search:** **`8.13 – 8.49 µs`** per query over 1,000,000 relations (**~117,000 – 123,000 QPS**) with zero JS heap allocations in the hot path.
* **Fast Bulk Seeding:** **`199 – 266 ms`** to hash, sort, deduplicate, and commit **1,000,000 relations** (even in `DbMode.StrictAcid` with `fdatasync`).
* **Configurable ACID Durability:** Switch at runtime between `Volatile` (`0.25 µs` write), `FastWal` (`7.66 µs` write, survives `SIGKILL`), and `StrictAcid` (`fdatasync`, survives power loss) — with **0 ns read overhead**.
* **O(1) Tombstone Deletes & Atomic Upserts:** `removeArticle(id)` flips 1 bit in a `125 KB` L1-cache bitset; `upsertArticle` commits text + relations in a single SSE4.2 CRC32C WAL frame.

---

## Benchmarks (1,000,000 Relations, Linux x86_64)

| Durability Mode | Seeding (1M Rel.) | Single Write (Avg 1k) | Top-K Search (Avg 1k) | Throughput | Crash Guarantee |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `DbMode.Volatile` | `199.68 ms` | `0.251 µs` | `8.259 µs` | ~121,000 QPS | In-memory only |
| `DbMode.FastWal` | `230.25 ms` | `7.659 µs` | `8.493 µs` | ~117,700 QPS | Survives `SIGKILL` / process crash |
| `DbMode.StrictAcid` | `266.07 ms` | `1539.300 µs` | `8.129 µs` | ~123,000 QPS | Survives power loss (`fdatasync`) |

*Suite: `bun run test` (`11/11` passing: deduplication, `DungeonPath`, read-your-own-writes, rollback, `SIGKILL` WAL recovery, corrupt tail-frame rejection, tombstone compaction, atomic upsert).*

---

## Quickstart

```bash
bun run build:native
bun run test
```

```ts
import { Engine, DbMode } from "./packages/nerve-bun/src/engine";

Engine.setMode(DbMode.FastWal);

// Atomic text + keyword upsert (single CRC32C WAL frame)
Engine.upsertArticle(42, "Undead boss guarding the sunken crypt.", ["undead", "boss", "crypt"]);
Engine.upsertArticle(99, "Skeleton warrior patrolling the crypt.", ["undead", "crypt"]);

// Sub-10µs top-K overlap search with exclusion list
const matches = Engine.getTopMatchesUnique(["undead", "crypt"], [99], 3);
// -> [{ id: 42, score: 2 }]

const text = Engine.getArticleText(42);

// O(1) L1-bitset tombstone deletion (compacted on next merge)
Engine.removeArticle(42);
Engine.triggerAsyncMerge();
```

---

## Architecture & Limits

* **Flat Sorted Pairs (`[u32; 2]`):** Stored as contiguous `(article_id, keyword_hash)` pairs. Binary search uses a branchless lower-bound loop followed by sequential cache-line scanning.
* **Sparse Score Tracking:** Tracks touched IDs in a stack buffer (`SPARSE_CAP = 16,384`) to avoid scanning the `4 MB` score slab on every query.
* **Typed WAL & Atomic Swap:** Frames (`RELATIONS`, `TEXT`, `DELETE_ARTICLE`) are checksummed via x86_64 `_mm_crc32_u64`. Compaction writes to `*.tmp`, calls `fsync`, and swaps atomically via `rename`.
* **Hard Limits:** Max `1,000,000` article IDs (`0..999,999`), max `128` top-K results, max `4,096` query/exclude items per call, `32-bit` lowercase keyword hashes, `4 GB` max `texts.bin` size, single-writer process model.

---

## Zero-Coupling Ecosystem

Part of a modular trio of independent primitives sharing only a primitive `u32` Entity ID contract:

* **`nerve`** — Semantic tags, relations & payloads
* **`columns`** — AVX2/AVX-512 SIMD Structure-of-Arrays numeric store
* **`spatial`** — Cache-local flat 2D spatial grid & radius queries

## License

MIT
