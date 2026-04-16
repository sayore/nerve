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




Geld
  -> Modern Money Theorie
  -> Entwicklung Tax für Reiche https://www.youtube.com/shorts/mL796eqCQko
Soziales
  -> Wohnungsmangel
  -> Leerstehende Wohnung/Häuser/..

Kategorie > Sub Kategorie > Konkreter Text > Enthält [[Keywords]]

Keywords gehören in Gruppen

Keywords pointen auf Texte die in einer Gruppe sind

Gruppen auch. 

Keywords == Gruppe?

Keyword in "gruppen" > Konkreter Text zu keyword (in gruppe) > Keywords
vs
Keyword n:m Text, Text m:n Keyword

Text mit keywords..

dynamisches info scrolling by selection of keywords, best match = next text ?


Sozial, Wohnung, Leerstand, Protestierbar, Aktiv..
Regex match auf n:m ist ineffizient..
binary tree? 3 layer 4kb match für string match sollte alles abdecken.. das meiste.. 

suchinput = best matching keywords (fzf like, buchstaben zählen in reihenfolge) = no binary tree.. double stored?

alikness reconciliation?

keywords uniqueness. but closeness? not related to term though..

hm