// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LIB_PATH = join(import.meta.dir, "../core/target/release/libsearch.so");
const LOG_PATH = join(import.meta.dir, "../db/changes.log.bin");

const lib = dlopen(LIB_PATH, {
    process_query: { 
        args: [
            FFIType.ptr,   // articles_ptr
            FFIType.usize, // articles_len
            FFIType.ptr,   // query_ptr
            FFIType.usize, // query_len
            FFIType.ptr,   // out_scores_ptr
            FFIType.ptr    // top_results_ptr
        ], 
        returns: FFIType.void 
    },
});

const MAX_ARTICLES = 1_000_000;
const MAX_RELATIONS = 2_000_000;

const relations = new Uint32Array(MAX_RELATIONS); // [ArtID, Hash, ArtID, Hash...]
const scoreBuffer = new Uint32Array(new SharedArrayBuffer(MAX_ARTICLES * 4));
const resultBuffer = new Uint32Array(new SharedArrayBuffer(6 * 4)); // Top 3 (ID + Score)
let relCursor = 0;

// Init: Load from log if exists
if (existsSync(LOG_PATH)) {
    const logBuffer = readFileSync(LOG_PATH);
    const logView = new Uint32Array(logBuffer.buffer, logBuffer.byteOffset, logBuffer.byteLength / 4);
    for (let i = 0; i < logView.length; i += 3) {
        const op = logView[i];
        const articleId = logView[i+1];
        const hash = logView[i+2];
        
        if (op === 0) { // Add
            relations[relCursor++] = articleId;
            relations[relCursor++] = hash;
        }
    }
}

export const Engine = {
    addKeyword(articleId: number, word: string) {
        const hash = Number(BigInt.asUintN(32, Bun.hash(word) as bigint));
        
        relations[relCursor++] = articleId;
        relations[relCursor++] = hash;

        // Passives binäres Logging (OpCode 0 = Add)
        const entry = new Uint32Array([0, articleId, hash]);
        appendFileSync(LOG_PATH, Buffer.from(entry.buffer));
    },

    getTopMatches(activeKeywords: string[]) {
        const hashes = new Uint32Array(activeKeywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w) as bigint))));
        return this.searchRaw(hashes);
    },

    searchRaw(hashes: Uint32Array) {
        lib.symbols.process_query(
            ptr(relations), relCursor,
            ptr(hashes), hashes.length,
            ptr(scoreBuffer), ptr(resultBuffer)
        );

        const results = [];
        for (let i = 0; i < 3; i++) {
            const id = resultBuffer[i * 2];
            const score = resultBuffer[i * 2 + 1];
            if (score > 0) {
                results.push({ id, score });
            }
        }
        return results;
    }
};
