// src/engine.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const getLibPath = () => {
    const directPath = join(process.cwd(), "core/target/release/libsearch.so");
    if (existsSync(directPath)) return directPath;
    const devPath = join(process.cwd(), "../../../../", "core/target/release/libsearch.so");
    if (existsSync(devPath)) return devPath;
    const bundledPath = join(import.meta.dir, "../core/target/release/libsearch.so");
    if (existsSync(bundledPath)) return bundledPath;
    const bundledPath2 = join(import.meta.dir, "../libsearch.so");
    if (existsSync(bundledPath2)) return bundledPath2;
    const cwdPath = join(process.cwd(), "libsearch.so");
    if (existsSync(cwdPath)) return cwdPath;
    return join(import.meta.dir, "../core/target/release/libsearch.so");
};

const getFilePath = (filename: string) => {
    const directPath = join(process.cwd(), filename);
    if (existsSync(directPath)) return directPath;
    const devPath = join(process.cwd(), "../../../../", filename);
    if (existsSync(devPath)) return devPath;
    const bundlePath = join(process.cwd(), "../../../", filename);
    if (existsSync(bundlePath)) return bundlePath;
    return join(process.cwd(), filename);
};

const LIB_PATH = getLibPath();
const LOG_PATH = getFilePath("db/changes.log.bin");
const DB_PATH = getFilePath("db/sorted.bin");
const TEXT_PATH = getFilePath("db/texts.bin");
const TEXT_INDEX_PATH = getFilePath("db/texts_index.bin");

console.log(`Loading Nerve Engine from: ${LIB_PATH}`);

const lib = dlopen(LIB_PATH, {
    get_article_text: {
        args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.u32],
        returns: FFIType.ptr
    },
    free_article_text: {
        args: [FFIType.ptr],
        returns: FFIType.void
    },
    process_query_sorted_unique: { 
        args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.ptr], 
        returns: FFIType.void 
    },
    intersect_keywords: {
        args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr],
        returns: FFIType.usize
    },
    merge_database: {
        args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr],
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

const scoreBuffer = new Uint32Array(MAX_ARTICLES);
const resultBuffer = new Uint32Array(6); 
const textOutputBuffer = new Uint8Array(4096);
const dummyU32 = new Uint32Array(1);
const dummyU8 = new Uint8Array(1);
let isSearching = false;

let textsMMap = new Uint8Array(0);
let textsIndex = new Uint32Array(0);

// Keep strong references to prevent GC of underlying memory
let __textsBuf: Buffer | null = null;
let __idxBuf: Buffer | null = null;
let __dbBuf: Buffer | null = null;

if (existsSync(TEXT_PATH) && existsSync(TEXT_INDEX_PATH)) {
    try {
        __textsBuf = readFileSync(TEXT_PATH);
        textsMMap = new Uint8Array(__textsBuf.buffer, __textsBuf.byteOffset, __textsBuf.byteLength);

        __idxBuf = readFileSync(TEXT_INDEX_PATH);
        textsIndex = new Uint32Array(__idxBuf.buffer, __idxBuf.byteOffset, __idxBuf.byteLength / 4);
    } catch (e) {
        console.error("Failed to load text database:", e);
    }
}

if (existsSync(DB_PATH)) {
    try {
        __dbBuf = readFileSync(DB_PATH);
        mmapRelations = new Uint32Array(__dbBuf.buffer, __dbBuf.byteOffset, __dbBuf.byteLength / 4);
        mmapCursor = mmapRelations.length;
    } catch (e) {
        console.error("Failed to load sorted database:", e);
    }
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
        if (isSearching) return;
        const nextMmapRelations = new Uint32Array(mmapCursor + ramCursor);
        const resultLen = lib.symbols.merge_database(
            ptr(mmapRelations.length > 0 ? mmapRelations : dummyU32), mmapCursor,
            ptr(ramBuffer.length > 0 ? ramBuffer : dummyU32), ramCursor,
            ptr(nextMmapRelations.length > 0 ? nextMmapRelations : dummyU32)
        );
        mmapRelations = nextMmapRelations;
        mmapCursor = Number(resultLen);
        ramCursor = 0;
        writeFileSync(DB_PATH, Buffer.from(mmapRelations.buffer));
        writeFileSync(LOG_PATH, Buffer.from([]));
    },

    intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
        if (a.length === 0 || b.length === 0) return new Uint32Array(0);
        const out = new Uint32Array(Math.min(a.length, b.length));
        const len = lib.symbols.intersect_keywords(ptr(a), a.length, ptr(b), b.length, ptr(out));
        return out.slice(0, Number(len));
    },

    getTopMatchesUnique(keywords: string[], exclude: number[]) {
        const hashes = new Uint32Array(keywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w) as bigint))));
        return this.searchRaw(hashes, exclude);
    },

    searchRaw(hashes: Uint32Array, exclude: number[] = []) {
        if (isSearching) return [];
        isSearching = true;
        try {
            const excludeBuffer = new Uint32Array(exclude);
            lib.symbols.process_query_sorted_unique(
                ptr(mmapRelations.length > 0 ? mmapRelations : dummyU32), mmapCursor,
                ptr(hashes.length > 0 ? hashes : dummyU32), hashes.length,
                ptr(excludeBuffer.length > 0 ? excludeBuffer : dummyU32), excludeBuffer.length,
                ptr(scoreBuffer), ptr(resultBuffer)
            );
            const results = [];
            for (let i = 0; i < 3; i++) {
                const id = resultBuffer[i * 2];
                const score = resultBuffer[i * 2 + 1];
                if (score > 0) results.push({ id, score });
            }
            return results;
        } finally {
            isSearching = false;
        }
    },

    getArticleText(articleId: number): string {
        if (textsMMap.length === 0 || textsIndex.length === 0) return `Article #${articleId} - No content loaded. Run seeding.`;
        
        const textPtr = lib.symbols.get_article_text(
            ptr(textsMMap), textsMMap.length, 
            ptr(textsIndex), textsIndex.length, 
            articleId
        );
        
        if (textPtr === 0 || textPtr === null) return `Article #${articleId} - Content not found.`;
        
        const text = new Bun.CString(textPtr as any);
        lib.symbols.free_article_text(textPtr);
        return text;
    },

    getKeywordsForArticle(articleId: number): string[] {
        const keywords: number[] = [];
        for (let i = 0; i < mmapCursor; i += 2) {
            if (mmapRelations[i] === articleId) keywords.push(mmapRelations[i + 1]);
        }
        return keywords.map(h => `hash_${h}`);
    }
};

export class DungeonPath {
    lockedNodes: number[] = [];
    nodeKeywords: string[][] = [];
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
            this.currentKeywords = ["word_1_5", "word_2_5"];
            return;
        }
        let intersectionHashes = new Uint32Array(this.nodeKeywords[0].map(k => Number(BigInt.asUintN(32, Bun.hash(k) as bigint))));
        for (let i = 1; i < this.nodeKeywords.length; i++) {
            const nextHashes = new Uint32Array(this.nodeKeywords[i].map(k => Number(BigInt.asUintN(32, Bun.hash(k) as bigint))));
            intersectionHashes = Engine.intersect(intersectionHashes, nextHashes);
        }
        this.currentKeywords = Array.from(intersectionHashes).map(h => `hash_${h}`);
    }
}
