// packages/nerve-ui/src/import.ts
import { Engine, DbMode } from "nerve-bun";
import { readdirSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_ROOT = join(import.meta.dir, "../../..");
const IMPORT_DIR = join(WORKSPACE_ROOT, "import");
const ARCHIVE_DIR = join(WORKSPACE_ROOT, "indb");
const TEXT_INDEX_PATH = join(WORKSPACE_ROOT, "db/texts_index.bin");

async function runImport() {
    console.log("--- Nerve Content Ingestion Pipeline ---");
    Engine.setMode(DbMode.FastWal);

    if (!existsSync(IMPORT_DIR)) {
        console.log("Kein ./import-Verzeichnis gefunden.");
        return;
    }
    if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

    const files = readdirSync(IMPORT_DIR).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
    if (files.length === 0) {
        console.log("Keine neuen Artikel in ./import gefunden.");
        return;
    }

    let nextArticleId = 0;
    if (existsSync(TEXT_INDEX_PATH)) {
        const idxBuf = readFileSync(TEXT_INDEX_PATH);
        const view = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, idxBuf.byteLength / 4);
        for (let i = 0; i < view.length; i += 3) {
            if (view[i + 2] > 0 && view[i] >= nextArticleId) {
                nextArticleId = view[i] + 1;
            }
        }
    }

    let imported = 0;
    Engine.beginTransaction();
    for (const file of files) {
        const filePath = join(IMPORT_DIR, file);
        const raw = readFileSync(filePath, "utf-8");

        const startIdx = raw.indexOf("[ARTICLE_START]");
        const endIdx = raw.indexOf("[ARTICLE_END]");
        if (startIdx === -1 || endIdx === -1) {
            console.warn(`Skipping ${file}: Ungültiges Format (Marker fehlen).`);
            continue;
        }

        const block = raw.substring(startIdx, endIdx);
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

        console.log(`Importiere: ${title} (ID: ${nextArticleId})...`);
        const fullText = `TITLE: ${title}\n\n${content}`;
        Engine.upsertArticle(nextArticleId, fullText, keywords);

        nextArticleId++;
        imported++;
        renameSync(filePath, join(ARCHIVE_DIR, file));
    }
    Engine.commitTransaction();

    if (imported > 0) {
        console.log("Synchronisiere Datenbank...");
        Engine.triggerAsyncMerge();
    }
    console.log(`Import abgeschlossen (${imported} Artikel).`);
}

runImport().catch(console.error);
