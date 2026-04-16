// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const getLibPath = () => {
    // 1. Try project root directly (for perf tests, assuming cwd is project root)
    const directPath = join(process.cwd(), "core/target/release/libsearch.so");
    if (existsSync(directPath)) return directPath;

    // 2. Try from Electrobun bin folder (4 levels up to project root)
    const devPath = join(process.cwd(), "../../../../", "core/target/release/libsearch.so");
    if (existsSync(devPath)) return devPath;

    // 3. Try relative path (bundled in app bundle)
    const bundledPath = join(import.meta.dir, "../core/target/release/libsearch.so");
    if (existsSync(bundledPath)) return bundledPath;

    const bundledPath2 = join(import.meta.dir, "../libsearch.so");
    if (existsSync(bundledPath2)) return bundledPath2;

    // 4. Last resort: current working directory
    const cwdPath = join(process.cwd(), "libsearch.so");
    if (existsSync(cwdPath)) return cwdPath;

    // Final fallback
    return join(import.meta.dir, "../core/target/release/libsearch.so");
};

const getFilePath = (filename: string) => {
    // 1. Try project root directly (for perf tests)
    const directPath = join(process.cwd(), filename);
    if (existsSync(directPath)) return directPath;

    // 2. Try original project root (4 levels up from bin/ in dev)
    const devPath = join(process.cwd(), "../../../../", filename);
    if (existsSync(devPath)) return devPath;

    // 3. Try bundled app structure
    const bundlePath = join(process.cwd(), "../../../", filename);
    if (existsSync(bundlePath)) return bundlePath;

    return join(process.cwd(), filename);
};
const LIB_PATH = getLibPath();
const LOG_PATH = getFilePath("db/changes.log.bin");
const DB_PATH = getFilePath("db/sorted.bin");

console.log(`Loading Nerve Engine from: ${LIB_PATH}`);

const lib = dlopen(LIB_PATH, {
    process_query_sorted_unique: { 
        args: [
            FFIType.ptr,   // articles_ptr
            FFIType.usize, // articles_len
            FFIType.ptr,   // query_ptr
            FFIType.usize, // query_len
            FFIType.ptr,   // exclude_ptr
            FFIType.usize, // exclude_len
            FFIType.ptr,   // out_scores_ptr
            FFIType.ptr    // top_results_ptr
        ], 
        returns: FFIType.void 
    },
    intersect_keywords: {
        args: [
            FFIType.ptr,   // a_ptr
            FFIType.usize, // a_len
            FFIType.ptr,   // b_ptr
            FFIType.usize, // b_len
            FFIType.ptr    // out_ptr
        ],
        returns: FFIType.usize
    },
    merge_database: {
        args: [
            FFIType.ptr,   // old_mmap_ptr
            FFIType.usize, // old_len
            FFIType.ptr,   // new_data_ptr
            FFIType.usize, // new_len
            FFIType.ptr    // out_mmap_ptr
        ],
        returns: FFIType.usize
    }
});

const MAX_ARTICLES = 1_000_000;
const MAX_RELATIONS = 100_000_000;
const MAX_RAM_BUFFER = 100_000;

let mmapRelations = new Uint32Array(0);
let mmapCursor = 0;
const ramBuffer = new Uint32Array(MAX_RAM_BUFFER);
let ramCursor = 0;

const scoreBuffer = new Uint32Array(new SharedArrayBuffer(MAX_ARTICLES * 4));
const resultBuffer = new Uint32Array(new SharedArrayBuffer(6 * 4)); 

// Init
if (existsSync(DB_PATH)) {
    const dbBuffer = readFileSync(DB_PATH);
    mmapRelations = new Uint32Array(dbBuffer.buffer);
    mmapCursor = mmapRelations.length;
}

export const Engine = {
    addKeyword(articleId: number, word: string) {
        const hash = Number(BigInt.asUintN(32, Bun.hash(word) as bigint));
        ramBuffer[ramCursor++] = articleId;
        ramBuffer[ramCursor++] = hash;
        const entry = new Uint32Array([0, articleId, hash]);
        appendFileSync(LOG_PATH, Buffer.from(entry.buffer));
        if (ramCursor >= MAX_RAM_BUFFER) this.triggerAsyncMerge();
    },

    triggerAsyncMerge() {
        const newTotalLen = mmapCursor + ramCursor;
        const nextMmapRelations = new Uint32Array(newTotalLen);
        const resultLen = lib.symbols.merge_database(
            ptr(mmapRelations), mmapCursor,
            ptr(ramBuffer), ramCursor,
            ptr(nextMmapRelations)
        );
        mmapRelations = nextMmapRelations;
        mmapCursor = Number(resultLen);
        ramCursor = 0;
        writeFileSync(DB_PATH, Buffer.from(mmapRelations.buffer));
        writeFileSync(LOG_PATH, Buffer.from([]));
    },

    intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
        const out = new Uint32Array(Math.min(a.length, b.length));
        const len = lib.symbols.intersect_keywords(ptr(a), a.length, ptr(b), b.length, ptr(out));
        return out.slice(0, Number(len));
    },

    getTopMatchesUnique(keywords: string[], exclude: number[]) {
        const hashes = new Uint32Array(keywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w) as bigint))));
        const excludeBuffer = new Uint32Array(exclude);
        
        lib.symbols.process_query_sorted_unique(
            ptr(mmapRelations), mmapCursor,
            ptr(hashes), hashes.length,
            ptr(excludeBuffer), excludeBuffer.length,
            ptr(scoreBuffer), ptr(resultBuffer)
        );

        const results = [];
        for (let i = 0; i < 3; i++) {
            const id = resultBuffer[i * 2];
            const score = resultBuffer[i * 2 + 1];
            if (score > 0) results.push({ id, score });
        }
        return results;
    },

    // Get all keywords for an article
    getKeywordsForArticle(articleId: number): string[] {
        // This is slow in the current linear layout, but for small sets it's fine.
        // In a real Arch system, we'd have an index for this too.
        const keywords: number[] = [];
        for (let i = 0; i < mmapCursor; i += 2) {
            if (mmapRelations[i] === articleId) {
                keywords.push(mmapRelations[i + 1]);
            }
        }
        // This is a placeholder since we can't easily reverse Bun.hash
        // In the real app, we'd store a hash -> word map.
        return keywords.map(h => `hash_${h}`);
    }
};

/**
 * Dungeon State Manager
 */
export class DungeonPath {
    lockedNodes: number[] = [];
    nodeKeywords: string[][] = []; // Store keywords for each node in path
    currentKeywords: string[] = [];

    async lockNode(articleId: number, keywords: string[]) {
        this.lockedNodes.push(articleId);
        this.nodeKeywords.push(keywords);
        
        this.recalculateIntersection();
        return Engine.getTopMatchesUnique(this.currentKeywords, this.lockedNodes);
    }

    async unlockNode(index: number) {
        if (index >= 0 && index < this.lockedNodes.length) {
            this.lockedNodes.splice(index, 1);
            this.nodeKeywords.splice(index, 1);
            this.recalculateIntersection();
        }
        return Engine.getTopMatchesUnique(this.currentKeywords, this.lockedNodes);
    }

    private recalculateIntersection() {
        if (this.lockedNodes.length === 0) {
            this.currentKeywords = ["wissen", "daten", "rust"]; // Default
            return;
        }

        let intersectionHashes = new Uint32Array(this.nodeKeywords[0].map(k => 
            Number(BigInt.asUintN(32, Bun.hash(k) as bigint))
        ));

        for (let i = 1; i < this.nodeKeywords.length; i++) {
            const nextHashes = new Uint32Array(this.nodeKeywords[i].map(k => 
                Number(BigInt.asUintN(32, Bun.hash(k) as bigint))
            ));
            intersectionHashes = Engine.intersect(intersectionHashes, nextHashes);
        }

        this.currentKeywords = Array.from(intersectionHashes).map(h => `hash_${h}`);
    }
}
