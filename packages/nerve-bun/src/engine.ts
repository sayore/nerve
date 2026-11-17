// packages/nerve-bun/src/engine.ts
import { ptr, dlopen, FFIType, CString } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export enum DbMode {
    Volatile = 0,
    FastWal = 1,
    StrictAcid = 2,
}

const FRAME_RELATIONS = 1;
const FRAME_TEXT = 2;
const FRAME_DELETE_ARTICLE = 3;
const TOMBSTONE_BIT = 0x8000_0000;

const getLibPath = () => {
    const directPath = join(process.cwd(), "packages/nerve-core/target/release/libnerve_core.so");
    if (existsSync(directPath)) return directPath;
    const devPath = join(process.cwd(), "../../../../", "packages/nerve-core/target/release/libnerve_core.so");
    if (existsSync(devPath)) return devPath;
    const bundledPath = join(import.meta.dir, "../../nerve-core/target/release/libnerve_core.so");
    if (existsSync(bundledPath)) return bundledPath;
    const bundledPath2 = join(import.meta.dir, "../libnerve_core.so");
    if (existsSync(bundledPath2)) return bundledPath2;
    const cwdPath = join(process.cwd(), "libnerve_core.so");
    if (existsSync(cwdPath)) return cwdPath;
    return join(import.meta.dir, "../../nerve-core/target/release/libnerve_core.so");
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

const encoder = new TextEncoder();
const toCStringBuf = (str: string) => encoder.encode(str + "\0");

const LIB_PATH = getLibPath();
const LOG_PATH = getFilePath("db/changes.log.bin");
const DB_PATH = getFilePath("db/sorted.bin");
const DB_TMP_PATH = getFilePath("db/sorted.bin.tmp");
const TEXT_PATH = getFilePath("db/texts.bin");
const TEXT_TMP_PATH = getFilePath("db/texts.bin.tmp");
const TEXT_INDEX_PATH = getFilePath("db/texts_index.bin");
const TEXT_INDEX_TMP_PATH = getFilePath("db/texts_index.bin.tmp");

const cLogPath = toCStringBuf(LOG_PATH);
const cDbPath = toCStringBuf(DB_PATH);
const cDbTmpPath = toCStringBuf(DB_TMP_PATH);
const cTextPath = toCStringBuf(TEXT_PATH);
const cTextTmpPath = toCStringBuf(TEXT_TMP_PATH);
const cTextIndexPath = toCStringBuf(TEXT_INDEX_PATH);
const cTextIndexTmpPath = toCStringBuf(TEXT_INDEX_TMP_PATH);

const lib = dlopen(LIB_PATH, {
    wal_open: { args: [FFIType.ptr], returns: FFIType.i32 },
    wal_close: { args: [FFIType.i32], returns: FFIType.void },
    wal_append_typed_frame: {
        args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
    },
    wal_next_frame: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
    },
    wal_truncate: { args: [FFIType.i32, FFIType.u32], returns: FFIType.void },
    atomic_write_file: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
    },
    get_article_text: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32],
        returns: FFIType.ptr,
    },
    free_article_text: { args: [FFIType.ptr], returns: FFIType.void },
    process_query_sorted_unique: {
        args: [
            FFIType.ptr, FFIType.u64,
            FFIType.ptr, FFIType.u64,
            FFIType.ptr, FFIType.u64,
            FFIType.ptr, FFIType.u64,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.ptr, FFIType.ptr, FFIType.u64,
        ],
        returns: FFIType.void,
    },
    intersect_keywords: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.u64,
    },
    merge_database_compact: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.u64,
    },
});

const MAX_ARTICLES = 1_000_000;
const MAX_RAM_BUFFER = 2_000_000;

let mmapRelations = new Uint32Array(0);
let mmapCursor = 0;

const ramBuffer = new Uint32Array(MAX_RAM_BUFFER);
let ramCursor = 0;
let txStartCursor = 0;

// L1/L2-residentes Tombstone-Bitset für gelöschte Artikel (125 KB)
const deletedBits = new Uint32Array(MAX_ARTICLES >>> 5);
// Bitset für im aktuellen Batch upserted Artikel (verhindert Auferstehung alter Relationen beim Merge)
const upsertedBits = new Uint32Array(MAX_ARTICLES >>> 5);

const scoreBuffer = new Uint32Array(MAX_ARTICLES);

const MAX_TOP_K = 128;
const resultBuffer = new Uint32Array(MAX_TOP_K * 2);

const queryScratch = new Uint32Array(4096);
const excludeScratch = new Uint32Array(4096);
const singleU32Scratch = new Uint32Array(2);
const frameMetaScratch = new Uint32Array(4);
const dummyU32 = new Uint32Array(1);

let currentMode: DbMode = DbMode.FastWal;
let walFd: number = -1;
let inTransaction = false;
let isSearching = false;

// Dynamisch wachsender In-Memory Text-Speicher + O(1) Index
let textsCapacity = 1024 * 1024;
let textsData = new Uint8Array(textsCapacity);
let textsByteLen = 0;
let textsIndex = new Uint32Array(MAX_ARTICLES * 3);
let textsDirty = false;

let __dbBuf: Buffer | null = null;

export function hashKeyword(word: string): number {
    if (word.length > 5 && word.charCodeAt(0) === 104 && word.startsWith("hash_")) {
        const parsed = Number(word.slice(5));
        if (!Number.isNaN(parsed)) return parsed >>> 0;
    }
    return Number((Bun.hash(word.toLowerCase()) as bigint) & 0xffffffffn) >>> 0;
}

function ensureWalFd(): number {
    if (walFd < 0 && currentMode !== DbMode.Volatile) {
        walFd = lib.symbols.wal_open(ptr(cLogPath));
    }
    return walFd;
}

function appendTextInMemory(articleId: number, utf8Bytes: Uint8Array) {
    const needed = textsByteLen + utf8Bytes.byteLength;
    if (needed > textsCapacity) {
        while (textsCapacity < needed) textsCapacity *= 2;
        const next = new Uint8Array(textsCapacity);
        next.set(textsData.subarray(0, textsByteLen));
        textsData = next;
    }
    const offset = textsByteLen;
    textsData.set(utf8Bytes, offset);
    textsByteLen += utf8Bytes.byteLength;

    const base = articleId * 3;
    textsIndex[base] = articleId;
    textsIndex[base + 1] = offset;
    textsIndex[base + 2] = utf8Bytes.byteLength;
    textsDirty = true;
}

function writeRawRelationVolatile(rawId: number, hash: number) {
    if (ramCursor + 2 > MAX_RAM_BUFFER) {
        Engine.triggerAsyncMerge();
    }
    ramBuffer[ramCursor++] = rawId;
    ramBuffer[ramCursor++] = hash;
}

function writeRawRelationImmediate(rawId: number, hash: number) {
    if (ramCursor + 2 > MAX_RAM_BUFFER) {
        Engine.triggerAsyncMerge();
    }
    const byteOffset = ramCursor * 4;
    ramBuffer[ramCursor++] = rawId;
    ramBuffer[ramCursor++] = hash;
    lib.symbols.wal_append_typed_frame(
        ensureWalFd(),
        FRAME_RELATIONS,
        ((ptr(ramBuffer) as unknown as number) + byteOffset) as any,
        8,
        currentMode,
        1
    );
}

function addKeywordVolatile(articleId: number, word: string) {
    writeRawRelationVolatile(articleId >>> 0, hashKeyword(word));
}

function addKeywordImmediate(articleId: number, word: string) {
    writeRawRelationImmediate(articleId >>> 0, hashKeyword(word));
}

function reloadFromDisk() {
    if (existsSync(TEXT_PATH) && existsSync(TEXT_INDEX_PATH)) {
        try {
            const tBuf = readFileSync(TEXT_PATH);
            textsCapacity = Math.max(textsCapacity, tBuf.byteLength * 2);
            textsData = new Uint8Array(textsCapacity);
            textsData.set(tBuf);
            textsByteLen = tBuf.byteLength;

            const iBuf = readFileSync(TEXT_INDEX_PATH);
            const loadedIdx = new Uint32Array(iBuf.buffer, iBuf.byteOffset, iBuf.byteLength / 4);
            for (let i = 0; i + 2 < loadedIdx.length; i += 3) {
                const id = loadedIdx[i];
                const len = loadedIdx[i + 2];
                if (id < MAX_ARTICLES && len > 0) {
                    const base = id * 3;
                    textsIndex[base] = id;
                    textsIndex[base + 1] = loadedIdx[i + 1];
                    textsIndex[base + 2] = len;
                }
            }
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
    } else {
        mmapRelations = new Uint32Array(0);
        mmapCursor = 0;
    }

    if (existsSync(LOG_PATH)) {
        const walBuf = readFileSync(LOG_PATH);
        if (walBuf.byteLength >= 16) {
            const walPtr = ptr(walBuf);
            const metaPtr = ptr(frameMetaScratch);
            let offset = 0;
            let recoveredAny = false;

            while (lib.symbols.wal_next_frame(walPtr, walBuf.byteLength, offset, metaPtr) === 1) {
                const frameType = frameMetaScratch[0];
                const payloadOffset = frameMetaScratch[1];
                const byteLen = frameMetaScratch[2];
                offset = frameMetaScratch[3];
                recoveredAny = true;

                if (frameType === FRAME_RELATIONS) {
                    const count = byteLen >>> 2;
                    if (ramCursor + count > MAX_RAM_BUFFER) {
                        Engine.triggerAsyncMerge();
                    }
                    const src = new Uint32Array(walBuf.buffer, walBuf.byteOffset + payloadOffset, count);
                    ramBuffer.set(src, ramCursor);
                    ramCursor += count;
                } else if (frameType === FRAME_DELETE_ARTICLE) {
                    const dv = new DataView(walBuf.buffer, walBuf.byteOffset + payloadOffset, 4);
                    const delId = dv.getUint32(0, true);
                    if (delId < MAX_ARTICLES) {
                        deletedBits[delId >>> 5] |= 1 << (delId & 31);
                        textsIndex[delId * 3 + 2] = 0;
                        textsDirty = true;
                    }
                } else if (frameType === FRAME_TEXT) {
                    const dv = new DataView(walBuf.buffer, walBuf.byteOffset + payloadOffset, byteLen);
                    const artId = dv.getUint32(0, true);
                    const textBytes = new Uint8Array(walBuf.buffer, walBuf.byteOffset + payloadOffset + 4, byteLen - 4);
                    if (artId < MAX_ARTICLES) {
                        deletedBits[artId >>> 5] &= ~(1 << (artId & 31));
                        upsertedBits[artId >>> 5] |= 1 << (artId & 31);
                        appendTextInMemory(artId, textBytes);
                    }
                }
            }

            if (recoveredAny) {
                Engine.triggerAsyncMerge();
            }
        }
    }
}

export const Engine = {
    setMode(mode: DbMode) {
        currentMode = mode;
        if (mode === DbMode.Volatile) {
            if (walFd >= 0) {
                lib.symbols.wal_close(walFd);
                walFd = -1;
            }
            this.addKeyword = addKeywordVolatile;
        } else {
            ensureWalFd();
            this.addKeyword = inTransaction ? addKeywordVolatile : addKeywordImmediate;
        }
    },

    getMode(): DbMode {
        return currentMode;
    },

    reset() {
        mmapRelations = new Uint32Array(0);
        mmapCursor = 0;
        ramCursor = 0;
        txStartCursor = 0;
        inTransaction = false;
        deletedBits.fill(0);
        upsertedBits.fill(0);
        scoreBuffer.fill(0);
        resultBuffer.fill(0);
        textsByteLen = 0;
        textsIndex.fill(0);
        textsDirty = false;
        __dbBuf = null;
        if (walFd >= 0) {
            lib.symbols.wal_close(walFd);
            walFd = -1;
        }
    },

    beginTransaction() {
        inTransaction = true;
        txStartCursor = ramCursor;
        this.addKeyword = addKeywordVolatile;
    },

    commitTransaction() {
        if (!inTransaction) return;
        inTransaction = false;
        const count = ramCursor - txStartCursor;
        if (count > 0 && currentMode !== DbMode.Volatile) {
            const byteOffset = txStartCursor * 4;
            lib.symbols.wal_append_typed_frame(
                ensureWalFd(),
                FRAME_RELATIONS,
                ((ptr(ramBuffer) as unknown as number) + byteOffset) as any,
                count * 4,
                currentMode,
                1
            );
        }
        txStartCursor = ramCursor;
        this.addKeyword = currentMode === DbMode.Volatile ? addKeywordVolatile : addKeywordImmediate;
        if (ramCursor >= MAX_RAM_BUFFER) this.triggerAsyncMerge();
    },

    rollbackTransaction() {
        if (!inTransaction) return;
        ramCursor = txStartCursor;
        inTransaction = false;
        this.addKeyword = currentMode === DbMode.Volatile ? addKeywordVolatile : addKeywordImmediate;
    },

    addKeyword: addKeywordImmediate,

    /** O(1) Bitset-Tombstone für ganzen Artikel (~1ns im L1-Cache, physische Compaction beim nächsten Merge) */
    removeArticle(articleId: number) {
        if (articleId < 0 || articleId >= MAX_ARTICLES) return;
        deletedBits[articleId >>> 5] |= 1 << (articleId & 31);
        upsertedBits[articleId >>> 5] &= ~(1 << (articleId & 31));
        textsIndex[articleId * 3 + 2] = 0;
        textsDirty = true;

        if (currentMode !== DbMode.Volatile) {
            singleU32Scratch[0] = articleId >>> 0;
            lib.symbols.wal_append_typed_frame(
                ensureWalFd(),
                FRAME_DELETE_ARTICLE,
                ptr(singleU32Scratch) as any,
                4,
                currentMode,
                inTransaction ? 0 : 1
            );
        }
    },

    /** Entfernt gezielt eine einzelne (articleId, word)-Relation über MSB-Tombstone */
    removeKeyword(articleId: number, word: string) {
        if (articleId < 0 || articleId >= MAX_ARTICLES) return;
        const tombstoneId = (articleId | TOMBSTONE_BIT) >>> 0;
        const hash = hashKeyword(word);
        if (inTransaction || currentMode === DbMode.Volatile) {
            writeRawRelationVolatile(tombstoneId, hash);
        } else {
            writeRawRelationImmediate(tombstoneId, hash);
        }
    },

    /**
     * Atomarer Upsert von Text + Keywords in einer einzigen Transaktion (1x Hardware-CRC32C + 1x fdatasync).
     * Alte Relationen des Artikels werden per `upsertedBits` sofort ausgeblendet und beim Merge getilgt.
     */
    upsertArticle(articleId: number, text: string, keywords: string[]) {
        if (articleId < 0 || articleId >= MAX_ARTICLES) return;
        const wasInTx = inTransaction;
        if (!wasInTx) this.beginTransaction();

        // 1. Alte Relationen aus `mmapRelations` via `upsertedBits` sofort ausblenden
        deletedBits[articleId >>> 5] &= ~(1 << (articleId & 31));
        upsertedBits[articleId >>> 5] |= 1 << (articleId & 31);

        // 2. Neuen Text in RAM + WAL schreiben
        const encodedText = encoder.encode(text);
        appendTextInMemory(articleId, encodedText);

        if (currentMode !== DbMode.Volatile) {
            const frameBuf = new Uint8Array(4 + encodedText.byteLength);
            new DataView(frameBuf.buffer).setUint32(0, articleId >>> 0, true);
            frameBuf.set(encodedText, 4);
            lib.symbols.wal_append_typed_frame(
                ensureWalFd(),
                FRAME_TEXT,
                ptr(frameBuf),
                frameBuf.byteLength,
                currentMode,
                0
            );
        }

        // 3. Neue Keywords einfügen und alles mit einem einzigen fdatasync committen
        for (let i = 0; i < keywords.length; i++) {
            addKeywordVolatile(articleId, keywords[i]);
        }

        if (!wasInTx) this.commitTransaction();
    },

    triggerAsyncMerge() {
        if (isSearching) return;
        if (inTransaction && currentMode !== DbMode.Volatile) {
            const count = ramCursor - txStartCursor;
            if (count > 0) {
                const byteOffset = txStartCursor * 4;
                lib.symbols.wal_append_typed_frame(
                    ensureWalFd(),
                    FRAME_RELATIONS,
                    ((ptr(ramBuffer) as unknown as number) + byteOffset) as any,
                    count * 4,
                    currentMode,
                    0
                );
            }
        }

        const nextMmapRelations = new Uint32Array(mmapCursor + ramCursor);
        const resultLen = Number(
            lib.symbols.merge_database_compact(
                mmapCursor > 0 ? ptr(mmapRelations) : ptr(dummyU32),
                mmapCursor,
                ramCursor > 0 ? ptr(ramBuffer) : ptr(dummyU32),
                ramCursor,
                ptr(deletedBits),
                ptr(upsertedBits),
                nextMmapRelations.length > 0 ? ptr(nextMmapRelations) : ptr(dummyU32)
            )
        );

        mmapRelations = nextMmapRelations.subarray(0, resultLen);
        mmapCursor = resultLen;
        ramCursor = 0;
        txStartCursor = 0;

        if (currentMode !== DbMode.Volatile) {
            lib.symbols.atomic_write_file(
                mmapCursor > 0 ? ptr(mmapRelations) : ptr(dummyU32),
                mmapCursor * 4,
                ptr(cDbTmpPath),
                ptr(cDbPath),
                currentMode
            );

            if (textsDirty) {
                lib.symbols.atomic_write_file(
                    textsByteLen > 0 ? ptr(textsData) : ptr(dummyU32),
                    textsByteLen,
                    ptr(cTextTmpPath),
                    ptr(cTextPath),
                    currentMode
                );
                lib.symbols.atomic_write_file(
                    ptr(textsIndex),
                    textsIndex.byteLength,
                    ptr(cTextIndexTmpPath),
                    ptr(cTextIndexPath),
                    currentMode
                );
                textsDirty = false;
            }

            lib.symbols.wal_truncate(ensureWalFd(), currentMode);
        }
    },

    intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
        if (a.length === 0 || b.length === 0) return new Uint32Array(0);
        const out = new Uint32Array(Math.min(a.length, b.length));
        const len = lib.symbols.intersect_keywords(ptr(a), a.length, ptr(b), b.length, ptr(out));
        return out.slice(0, Number(len));
    },

    getTopMatchesUnique(keywords: string[], exclude: number[], topK: number = 3) {
        if (isSearching || (mmapCursor === 0 && ramCursor === 0) || keywords.length === 0) return [];
        isSearching = true;
        try {
            const qLen = Math.min(keywords.length, queryScratch.length);
            for (let i = 0; i < qLen; i++) {
                queryScratch[i] = hashKeyword(keywords[i]);
            }

            const exLen = Math.min(exclude.length, excludeScratch.length);
            for (let i = 0; i < exLen; i++) {
                excludeScratch[i] = exclude[i];
            }

            const effTopK = Math.min(topK, MAX_TOP_K);

            lib.symbols.process_query_sorted_unique(
                mmapCursor > 0 ? ptr(mmapRelations) : ptr(dummyU32),
                mmapCursor,
                ramCursor > 0 ? ptr(ramBuffer) : ptr(dummyU32),
                ramCursor,
                qLen > 0 ? ptr(queryScratch) : ptr(dummyU32),
                qLen,
                exLen > 0 ? ptr(excludeScratch) : ptr(dummyU32),
                exLen,
                ptr(deletedBits),
                ptr(upsertedBits),
                ptr(scoreBuffer),
                ptr(resultBuffer),
                effTopK
            );

            const results: { id: number; score: number }[] = [];
            for (let i = 0; i < effTopK; i++) {
                const score = resultBuffer[i * 2 + 1];
                if (score === 0) break;
                results.push({ id: resultBuffer[i * 2], score });
            }
            return results;
        } finally {
            isSearching = false;
        }
    },

    searchRaw(hashes: Uint32Array, exclude: number[] = [], topK: number = 3) {
        if (isSearching || (mmapCursor === 0 && ramCursor === 0) || hashes.length === 0) return [];
        isSearching = true;
        try {
            const exLen = Math.min(exclude.length, excludeScratch.length);
            for (let i = 0; i < exLen; i++) {
                excludeScratch[i] = exclude[i];
            }

            const effTopK = Math.min(topK, MAX_TOP_K);

            lib.symbols.process_query_sorted_unique(
                mmapCursor > 0 ? ptr(mmapRelations) : ptr(dummyU32),
                mmapCursor,
                ramCursor > 0 ? ptr(ramBuffer) : ptr(dummyU32),
                ramCursor,
                hashes.length > 0 ? ptr(hashes) : ptr(dummyU32),
                hashes.length,
                exLen > 0 ? ptr(excludeScratch) : ptr(dummyU32),
                exLen,
                ptr(deletedBits),
                ptr(upsertedBits),
                ptr(scoreBuffer),
                ptr(resultBuffer),
                effTopK
            );

            const results: { id: number; score: number }[] = [];
            for (let i = 0; i < effTopK; i++) {
                const score = resultBuffer[i * 2 + 1];
                if (score === 0) break;
                results.push({ id: resultBuffer[i * 2], score });
            }
            return results;
        } finally {
            isSearching = false;
        }
    },

    getArticleText(articleId: number): string {
        if (textsByteLen === 0 || articleId < 0 || articleId >= MAX_ARTICLES) {
            return `Article #${articleId} - Content not found.`;
        }

        const textPtr = lib.symbols.get_article_text(
            ptr(textsData),
            textsByteLen,
            ptr(textsIndex),
            textsIndex.length,
            ptr(deletedBits),
            articleId
        );

        if (textPtr === 0 || textPtr === null) return `Article #${articleId} - Content not found.`;

        const text = new CString(textPtr as any).toString();
        lib.symbols.free_article_text(textPtr);
        return text;
    },

    getKeywordsForArticle(articleId: number): string[] {
        if ((deletedBits[articleId >>> 5] & (1 << (articleId & 31))) !== 0) return [];
        const set = new Set<number>();
        if ((upsertedBits[articleId >>> 5] & (1 << (articleId & 31))) === 0) {
            for (let i = 0; i < mmapCursor; i += 2) {
                if (mmapRelations[i] === articleId) set.add(mmapRelations[i + 1]);
            }
        }
        for (let i = 0; i < ramCursor; i += 2) {
            const rawId = ramBuffer[i];
            const id = rawId & 0x7fff_ffff;
            if (id === articleId) {
                if ((rawId & TOMBSTONE_BIT) !== 0) set.delete(ramBuffer[i + 1]);
                else set.add(ramBuffer[i + 1]);
            }
        }
        return Array.from(set, h => `hash_${h}`);
    }
};

export class DungeonPath {
    lockedNodes: number[] = [];
    nodeKeywords: string[][] = [];
    currentKeywords: string[] = [];
    currentHashes: Uint32Array = new Uint32Array(0);

    async lockNode(articleId: number, keywords: string[]) {
        this.lockedNodes.push(articleId);
        this.nodeKeywords.push(keywords);
        this.recalculateIntersection();
        return Engine.searchRaw(this.currentHashes, this.lockedNodes);
    }

    async unlockNode(index: number) {
        if (index >= 0 && index < this.lockedNodes.length) {
            this.lockedNodes.splice(index, 1);
            this.nodeKeywords.splice(index, 1);
            this.recalculateIntersection();
        }
        return Engine.searchRaw(this.currentHashes, this.lockedNodes);
    }

    private recalculateIntersection() {
        if (this.lockedNodes.length === 0) {
            this.currentKeywords = ["word_1_5", "word_2_5"];
            this.currentHashes = new Uint32Array(this.currentKeywords.map(hashKeyword));
            return;
        }
        let intersectionHashes = new Uint32Array(this.nodeKeywords[0].map(hashKeyword));
        for (let i = 1; i < this.nodeKeywords.length; i++) {
            const nextHashes = new Uint32Array(this.nodeKeywords[i].map(hashKeyword));
            intersectionHashes = Engine.intersect(intersectionHashes, nextHashes);
        }
        this.currentHashes = intersectionHashes;
        this.currentKeywords = Array.from(intersectionHashes).map(h => `hash_${h}`);
    }
}

reloadFromDisk();
