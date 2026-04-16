// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIB_PATH = join(import.meta.dir, "../core/target/release/libsearch.so");
const LOG_PATH = join(import.meta.dir, "../db/changes.log.bin");
const DB_PATH = join(import.meta.dir, "../db/sorted.bin");

const lib = dlopen(LIB_PATH, {
    process_query_sorted: { 
        args: [
            FFIType.ptr,   // articles_ptr
            FFIType.usize, // articles_len
            FFIType.ptr,   // query_ptr
            FFIType.usize, // query_len
            FFIType.ptr,   // out_scores_ptr
        ], 
        returns: FFIType.void 
    },
    process_query_linear: {
        args: [
            FFIType.ptr,   // articles_ptr
            FFIType.usize, // articles_len
            FFIType.ptr,   // query_ptr
            FFIType.usize, // query_len
            FFIType.ptr,   // out_scores_ptr
        ],
        returns: FFIType.void
    },
    find_top_3_ffi: {
        args: [
            FFIType.ptr, // scores_ptr
            FFIType.ptr  // top_results_ptr
        ],
        returns: FFIType.void
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
const MAX_RELATIONS = 100_000_000; // Increased scale
const MAX_RAM_BUFFER = 100_000; // 50k relations

let mmapRelations = new Uint32Array(0);
let mmapCursor = 0;
const ramBuffer = new Uint32Array(MAX_RAM_BUFFER);
let ramCursor = 0;

const scoreBuffer = new Uint32Array(new SharedArrayBuffer(MAX_ARTICLES * 4));
const resultBuffer = new Uint32Array(new SharedArrayBuffer(6 * 4)); 
const cursorBuffer = new BigUint64Array(1);

// Init: Load sorted database if exists
if (existsSync(DB_PATH)) {
    const dbBuffer = readFileSync(DB_PATH);
    mmapRelations = new Uint32Array(dbBuffer.buffer);
    mmapCursor = mmapRelations.length;
    console.log(`Sorted Database loaded. Relations: ${mmapCursor / 2}`);
}

// Also load changes log into RAM buffer (unsorted)
if (existsSync(LOG_PATH)) {
    const logBuffer = readFileSync(LOG_PATH);
    const logView = new Uint32Array(logBuffer.buffer, logBuffer.byteOffset, logBuffer.byteLength / 4);
    for (let i = 0; i < logView.length; i += 3) {
        if (logView[i] === 0) { // Add
            ramBuffer[ramCursor++] = logView[i+1];
            ramBuffer[ramCursor++] = logView[i+2];
        }
    }
    console.log(`Changes log loaded into RAM. Relations: ${ramCursor / 2}`);
}

export const Engine = {
    addKeyword(articleId: number, word: string) {
        const hash = Number(BigInt.asUintN(32, Bun.hash(word) as bigint));
        
        ramBuffer[ramCursor++] = articleId;
        ramBuffer[ramCursor++] = hash;

        // Passives binäres Logging
        const entry = new Uint32Array([0, articleId, hash]);
        appendFileSync(LOG_PATH, Buffer.from(entry.buffer));

        if (ramCursor >= MAX_RAM_BUFFER) {
            this.triggerAsyncMerge();
        }
    },

    triggerAsyncMerge() {
        console.log("Brutalist Merge: Optimizing Database...");
        
        const newTotalLen = mmapCursor + ramCursor;
        const nextMmapRelations = new Uint32Array(newTotalLen);
        
        let resultLen = 0;
        if (mmapCursor > 0) {
            resultLen = lib.symbols.merge_database(
                ptr(mmapRelations), mmapCursor,
                ptr(ramBuffer), ramCursor,
                ptr(nextMmapRelations)
            );
        } else {
            // If empty, just sort and copy the RAM buffer
            // We can still call merge_database with an empty old buffer 
            // if we are careful, but let's just do it cleanly.
            // Wait, we need to sort it. Let's just use merge_database with 
            // a small dummy buffer OR handle it in Rust.
            // Actually, we can just pass a small non-empty buffer if we want to 
            // keep the Rust code simple, OR fix Rust.
            // Let's just fix the JS part to not call FFI with empty ptr.
            
            // To be brutalist, we can just pass ptr(new Uint32Array(1)) and len 0
            resultLen = lib.symbols.merge_database(
                ptr(new Uint32Array(1)), 0,
                ptr(ramBuffer), ramCursor,
                ptr(nextMmapRelations)
            );
        }

        // Atomic swap & Persistence
        mmapRelations = nextMmapRelations;
        mmapCursor = Number(resultLen);
        ramCursor = 0;

        // Persist sorted database
        writeFileSync(DB_PATH, Buffer.from(mmapRelations.buffer));
        // Clear log after successful merge
        writeFileSync(LOG_PATH, Buffer.from([]));
        
        console.log(`Merge complete. Total relations: ${mmapCursor / 2}`);
    },

    getTopMatches(activeKeywords: string[]) {
        const hashes = new Uint32Array(activeKeywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w) as bigint))));
        return this.searchRaw(hashes);
    },

    searchRaw(hashes: Uint32Array) {
        // 1. Search Sorted MMap (O(log n))
        lib.symbols.process_query_sorted(
            ptr(mmapRelations), mmapCursor,
            ptr(hashes), hashes.length,
            ptr(scoreBuffer)
        );

        // 2. Accumulate Search from RAM Buffer (O(small_n))
        lib.symbols.process_query_linear(
            ptr(ramBuffer), ramCursor,
            ptr(hashes), hashes.length,
            ptr(scoreBuffer)
        );

        // 3. Final selection including the accumulated RAM buffer scores
        lib.symbols.find_top_3_ffi(
            ptr(scoreBuffer),
            ptr(resultBuffer)
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
