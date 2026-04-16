// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync } from "node:fs";
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
    mmap_load_database: {
        args: [
            FFIType.ptr,   // path_ptr
            FFIType.ptr,   // out_relations_ptr
            FFIType.usize, // max_relations
            FFIType.ptr    // out_cursor
        ],
        returns: FFIType.i32
    }
});

const MAX_ARTICLES = 1_000_000;
const MAX_RELATIONS = 2_000_000;

const relations = new Uint32Array(MAX_RELATIONS); // [ArtID, Hash, ArtID, Hash...]
const scoreBuffer = new Uint32Array(new SharedArrayBuffer(MAX_ARTICLES * 4));
const resultBuffer = new Uint32Array(new SharedArrayBuffer(6 * 4)); // Top 3 (ID + Score)
const cursorBuffer = new BigUint64Array(1); // To receive the cursor from Rust

let relCursor = 0;

// Init: Use Rust's mmap loader for instant startup
if (existsSync(LOG_PATH)) {
    const pathBuf = Buffer.from(LOG_PATH + "\0");
    const result = lib.symbols.mmap_load_database(
        ptr(pathBuf),
        ptr(relations),
        MAX_RELATIONS,
        ptr(cursorBuffer)
    );
    
    if (result === 0) {
        relCursor = Number(cursorBuffer[0]);
        console.log(`Database loaded via mmap. Relations: ${relCursor / 2}`);
    } else {
        console.error(`Failed to load database via mmap: ${result}`);
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
