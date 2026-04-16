// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIB_PATH = join(import.meta.dir, "../core/target/release/libsearch.so");
const LOG_PATH = join(import.meta.dir, "../db/changes.log.bin");
const DB_PATH = join(import.meta.dir, "../db/sorted.bin");

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
    currentKeywords: string[] = [];

    async lockNode(articleId: number, keywords: string[]) {
        this.lockedNodes.push(articleId);
        
        if (this.lockedNodes.length === 1) {
            this.currentKeywords = keywords;
        } else {
            // Simplify for now: just use the new keywords to "filter"
            // In a real intersection, we'd need the hashes.
            const currentHashes = new Uint32Array(this.currentKeywords.map(k => Number(BigInt.asUintN(32, Bun.hash(k) as bigint))));
            const nextHashes = new Uint32Array(keywords.map(k => Number(BigInt.asUintN(32, Bun.hash(k) as bigint))));
            
            const intersection = Engine.intersect(currentHashes, nextHashes);
            // Again, placeholder for hash -> word
            this.currentKeywords = Array.from(intersection).map(h => `hash_${h}`);
        }
        
        return Engine.getTopMatchesUnique(this.currentKeywords, this.lockedNodes);
    }
}
