// src/import.ts
import { Engine } from "./engine";
import { readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const IMPORT_DIR = join(import.meta.dir, "../import");
const ARCHIVE_DIR = join(import.meta.dir, "../indb");
const TEXT_PATH = join(import.meta.dir, "../db/texts.bin");
const TEXT_INDEX_PATH = join(import.meta.dir, "../db/texts_index.bin");

async function runImport() {
    console.log("--- Nerve Content Ingestion Pipeline ---");
    
    const files = readdirSync(IMPORT_DIR).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
    
    if (files.length === 0) {
        console.log("Keine neuen Artikel in ./import gefunden.");
        return;
    }

    // Load current index for offset tracking
    let currentOffset = 0;
    let nextArticleId = 0;
    
    if (existsSync(TEXT_PATH)) {
        currentOffset = readFileSync(TEXT_PATH).byteLength;
    }

    if (existsSync(TEXT_INDEX_PATH)) {
        const idxBuf = readFileSync(TEXT_INDEX_PATH);
        const view = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, idxBuf.byteLength / 4);
        for (let i = 0; i < view.length; i += 3) {
            if (view[i] >= nextArticleId) nextArticleId = view[i] + 1;
        }
    }

    for (const file of files) {
        const path = join(IMPORT_DIR, file);
        const raw = readFileSync(path, "utf-8");
        
        // Parsing using the [ARTICLE_START] structure
        const startIdx = raw.indexOf("[ARTICLE_START]");
        const endIdx = raw.indexOf("[ARTICLE_END]");
        
        if (startIdx === -1 || endIdx === -1) {
            console.warn(`Skipping ${file}: Ungültiges Format (Marker fehlen).`);
            continue;
        }

        const block = raw.substring(startIdx, endIdx);
        
        // Extract Title, Content and Keywords
        const titleMatch = block.match(/TITLE:\s*(.*)/);
        const contentMatch = block.match(/CONTENT:\s*\n([\s\S]*?)\nKEYWORDS:/);
        const keywordsMatch = block.match(/KEYWORDS:\s*(.*)/);

        if (!titleMatch || !contentMatch || !keywordsMatch) {
            console.warn(`Skipping ${file}: Meta-Daten unvollständig.`);
            continue;
        }

        const title = titleMatch[1].trim();
        const content = contentMatch[1].trim();
        const keywords = keywordsMatch[1].split(",").map(k => k.trim()).filter(k => k.length > 0);

        console.log(`Importiere: ${title} (ID: ${nextArticleId})...
`);

        // 1. Write Text
        const fullText = `TITLE: ${title}\n\n${content}`;
        const buf = Buffer.from(fullText);
        appendFileSync(TEXT_PATH, buf);

        // 2. Update Text Index [ID, Offset, Length]
        const indexEntry = new Uint32Array([nextArticleId, currentOffset, buf.length]);
        appendFileSync(TEXT_INDEX_PATH, Buffer.from(indexEntry.buffer));

        // 3. Update Search Engine Relations
        for (const kw of keywords) {
            Engine.addKeyword(nextArticleId, kw);
        }

        currentOffset += buf.length;
        nextArticleId++;

        // 4. Archive File
        renameSync(path, join(ARCHIVE_DIR, file));
    }

    console.log("Synchronisiere Datenbank...");
    Engine.triggerAsyncMerge();
    console.log("Import abgeschlossen.");
}

runImport().catch(console.error);
