Das ist ein hervorragender Plan. Mit **Electrobun** (Bun-native WebView) hast du den Vorteil, dass du direkt auf die Bun-APIs und FFI zugreifen kannst, ohne den Overhead von Electron.

Hier ist der architektonische Masterplan für dein Wissens-Netzwerk: **Brutalist, Dependency-less, High-Performance.**

---

## 1. Projektstruktur (Arch Linux Style)

Wir trennen strikt zwischen dem **Core** (Rust/FFI), der **Logik** (Bun/TS) und der **UI** (HTML/TS via Electrobun).

```text
.
├── core/
│   ├── src/lib.rs          # SIMD Scoring & Search (Rust)
│   └── Cargo.toml          # Rust Build Config
├── db/
│   ├── changes.log.bin     # Write-Ahead-Log (Append-only)
│   └── snapshot.bin        # Optionaler Memory-Dump
├── src/
│   ├── index.ts            # Electrobun Entry & Window Setup
│   ├── engine.ts           # FFI Wrapper & DB-Logik
│   └── ui/                 # Frontend (Vanilla TS/HTML)
│       ├── main.ts
│       └── index.html
├── Makefile                # Build-Automatisierung
└── package.json
```

---

## 2. Der Daten-Kern (Rust SIMD)

Der Fokus liegt auf der Berechnung der Verwandtschaft zwischen Artikeln durch Keyword-Schnittmengen.

```rust
// core/src/lib.rs
#[no_mangle]
pub extern "C" fn calculate_ranks(
    articles_ptr: *const u32,  // Layout: [ArticleID, KeywordHash, ...]
    len: usize,
    query_ptr: *const u32,     // Aktive Keywords
    query_len: usize,
    out_scores: *mut u32       // Resultat-Buffer
) {
    let articles = unsafe { std::slice::from_raw_parts(articles_ptr, len) };
    let queries = unsafe { std::slice::from_raw_parts(query_ptr, query_len) };
    let scores = unsafe { std::slice::from_raw_parts_mut(out_scores, 1000000) };

    // Reset scores
    for s in scores.iter_mut() { *s = 0; }

    // Linearer Scan durch Relationen
    // Rust auto-vektorisiert dies für AVX2/NEON
    for i in (0..len).step_by(2) {
        let art_id = articles[i] as usize;
        let kw_hash = articles[i+1];

        for &q in queries {
            if kw_hash == q {
                scores[art_id] += 1; // Match found
            }
        }
    }
}
```

---

## 3. Die Engine (Bun + FFI)

Hier findet das "Klick-to-Keyword" und das passive Logging statt.

```typescript
// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync } from "node:fs";

const lib = dlopen("./core/target/release/libsearch.so", {
    calculate_ranks: { 
        args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr], 
        returns: FFIType.void 
    },
});

const MAX_RELATIONS = 2_000_000;
const relations = new Uint32Array(MAX_RELATIONS); // [ArtID, Hash, ArtID, Hash...]
const scores = new Uint32Array(1_000_000); 
let relCursor = 0;

export const Engine = {
    // Wort-Klick in der UI -> Neues Keyword für Artikel
    addKeyword(articleId: number, word: string) {
        const hash = Bun.hash(word); // Extrem schneller MurmurHash3
        
        relations[relCursor++] = articleId;
        relations[relCursor++] = hash;

        // Passives binäres Logging (OpCode 0 = Add)
        const entry = new Uint32Array([0, articleId, hash]);
        appendFileSync("./db/changes.log.bin", Buffer.from(entry.buffer));
    },

    getTopMatches(activeKeywords: number[]) {
        const kwBuffer = new Uint32Array(activeKeywords);
        lib.symbols.calculate_ranks(
            ptr(relations), relCursor,
            ptr(kwBuffer), kwBuffer.length,
            ptr(scores)
        );
        // Rückgabe der Top 5 Artikel-IDs mit Score > 0
        return Array.from(scores)
            .map((s, i) => ({ id: i, score: s }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
    }
};
```

---

## 4. UI-Integration (Electrobun)

Im Frontend fängst du Klicks auf Wörter ab. Da es dein System ist, umschließt du beim Rendern jedes Wort mit einem `<span class="w">word</span>`.

```typescript
// src/ui/main.ts (Auszug)
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('w')) {
        const word = target.innerText.replace(/[^a-zA-Zäöüß]/g, "").toLowerCase();
        const articleId = getCurrentArticleId();
        
        // RPC-Call an den Bun-Main-Prozess
        Electrobun.rpc.call('addKeyword', { articleId, word });
        
        target.classList.add('is-keyword');
    }
});
```

---

## 5. Warum dieses Setup rockt

1.  **Binary Write-Ahead-Log**: Deine `changes.log.bin` ist unzerstörbar. Wenn die App crasht, liest Bun beim Start einfach die Datei linear ein und füllt das `relations`-Array wieder auf.
2.  **No Dependencies**: Du nutzt `Bun.hash`, `node:fs` und `bun:ffi`. Keine 500MB `node_modules`.
3.  **Speed**: Die Suche nach "Verwandten" passiert in Rust. Selbst bei 1M Keywords merkst du keine Verzögerung beim Tippen oder Klicken.
4.  **Brutalismus**: Keine komplexe SQL-Syntax. Nur flache Arrays und Hashes.