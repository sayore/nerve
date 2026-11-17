import { ptr, dlopen, FFIType, CString } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DbMode, hashKeyword } from "./engine";

export interface NerveMatch {
    id: number;
    score: number;
}

const MAX_ARTICLES = 1_000_000;
const MAX_RAM_BUFFER = 2_000_000;
const MAX_TOP_K = 128;
const FRAME_RELATIONS = 1;
const FRAME_DELETE_ARTICLE = 3;
const TOMBSTONE_BIT = 0x8000_0000;

const toCStringBuf = (str: string) => new TextEncoder().encode(str + "\0");

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

export class NerveAdapter {
    private lib: any;
    private dbPath: string;
    private dbTmpPath: string;
    private logPath: string;
    private textPath: string;
    private textIndexPath: string;

    private cLogPath: Uint8Array;
    private cDbPath: Uint8Array;
    private cDbTmpPath: Uint8Array;

    private mmapRelations: Uint32Array = new Uint32Array(0);
    private mmapCursor: number = 0;
    private ramBuffer: Uint32Array;
    private ramCursor: number = 0;

    private deletedBits = new Uint32Array(MAX_ARTICLES >>> 5);
    private upsertedBits = new Uint32Array(MAX_ARTICLES >>> 5);
    private scoreBuffer = new Uint32Array(MAX_ARTICLES);
    private resultBuffer = new Uint32Array(MAX_TOP_K * 2);
    private queryScratch = new Uint32Array(4096);
    private excludeScratch = new Uint32Array(4096);
    private singleU32Scratch = new Uint32Array(2);
    private frameMetaScratch = new Uint32Array(4);
    private dummyU32 = new Uint32Array(1);

    private textsMMap: Uint8Array = new Uint8Array(0);
    private textsIndex: Uint32Array = new Uint32Array(0);

    private mode: DbMode = DbMode.FastWal;
    private walFd: number = -1;
    private isSearching = false;

    constructor(basePath: string = "db/ai", mode: DbMode = DbMode.FastWal) {
        const fullBasePath = join(process.cwd(), basePath);
        if (!existsSync(fullBasePath)) {
            mkdirSync(fullBasePath, { recursive: true });
        }

        this.mode = mode;
        this.dbPath = join(fullBasePath, "sorted.bin");
        this.dbTmpPath = join(fullBasePath, "sorted.bin.tmp");
        this.logPath = join(fullBasePath, "changes.log.bin");
        this.textPath = join(fullBasePath, "texts.bin");
        this.textIndexPath = join(fullBasePath, "texts_index.bin");

        this.cLogPath = toCStringBuf(this.logPath);
        this.cDbPath = toCStringBuf(this.dbPath);
        this.cDbTmpPath = toCStringBuf(this.dbTmpPath);

        this.ramBuffer = new Uint32Array(MAX_RAM_BUFFER);

        const libPath = getLibPath();
        const sz = FFIType.u64;
        this.lib = dlopen(libPath, {
            wal_open: { args: [FFIType.ptr], returns: FFIType.i32 },
            wal_close: { args: [FFIType.i32], returns: FFIType.void },
            wal_append_typed_frame: {
                args: [FFIType.i32, FFIType.u32, FFIType.ptr, sz, FFIType.u32, FFIType.u32],
                returns: FFIType.i32
            },
            wal_next_frame: {
                args: [FFIType.ptr, sz, sz, FFIType.ptr],
                returns: FFIType.i32
            },
            wal_truncate: { args: [FFIType.i32, FFIType.u32], returns: FFIType.void },
            atomic_write_file: {
                args: [FFIType.ptr, sz, FFIType.ptr, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32
            },
            get_article_text: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, FFIType.u32],
                returns: FFIType.ptr
            },
            free_article_text: { args: [FFIType.ptr], returns: FFIType.void },
            process_query_sorted_unique: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, sz],
                returns: FFIType.void
            },
            intersect_keywords: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr],
                returns: sz
            },
            merge_database_compact: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, FFIType.ptr, FFIType.ptr],
                returns: sz
            }
        });

        this.loadDatabase();
    }

    private ensureWalFd(): number {
        if (this.walFd < 0 && this.mode !== DbMode.Volatile) {
            this.walFd = this.lib.symbols.wal_open(ptr(this.cLogPath));
        }
        return this.walFd;
    }

    private loadDatabase() {
        if (existsSync(this.textPath) && existsSync(this.textIndexPath)) {
            const textsBuf = readFileSync(this.textPath);
            this.textsMMap = new Uint8Array(textsBuf.buffer, textsBuf.byteOffset, textsBuf.byteLength);

            const idxBuf = readFileSync(this.textIndexPath);
            this.textsIndex = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, idxBuf.byteLength / 4);
        }

        if (existsSync(this.dbPath)) {
            const dbBuf = readFileSync(this.dbPath);
            this.mmapRelations = new Uint32Array(dbBuf.buffer, dbBuf.byteOffset, dbBuf.byteLength / 4);
            this.mmapCursor = this.mmapRelations.length;
        }

        if (existsSync(this.logPath)) {
            const walBuf = readFileSync(this.logPath);
            if (walBuf.byteLength >= 16) {
                const walPtr = ptr(walBuf);
                const metaPtr = ptr(this.frameMetaScratch);
                let offset = 0;
                let recoveredAny = false;
                while (this.lib.symbols.wal_next_frame(walPtr, walBuf.byteLength, offset, metaPtr) === 1) {
                    const frameType = this.frameMetaScratch[0];
                    const payloadOffset = this.frameMetaScratch[1];
                    const byteLen = this.frameMetaScratch[2];
                    offset = this.frameMetaScratch[3];
                    recoveredAny = true;
                    if (frameType === FRAME_RELATIONS) {
                        const count = byteLen >>> 2;
                        const src = new Uint32Array(walBuf.buffer, walBuf.byteOffset + payloadOffset, count);
                        this.ramBuffer.set(src, this.ramCursor);
                        this.ramCursor += count;
                    } else if (frameType === FRAME_DELETE_ARTICLE) {
                        const delId = new DataView(walBuf.buffer, walBuf.byteOffset + payloadOffset, 4).getUint32(0, true);
                        if (delId < MAX_ARTICLES) this.deletedBits[delId >>> 5] |= 1 << (delId & 31);
                    }
                }
                if (recoveredAny) this.merge();
            }
        }
    }

    public addKeyword(articleId: number, word: string) {
        if (this.ramCursor + 2 > MAX_RAM_BUFFER) {
            this.merge();
        }
        const hash = hashKeyword(word);
        const startOffset = this.ramCursor * 4;
        this.ramBuffer[this.ramCursor++] = articleId >>> 0;
        this.ramBuffer[this.ramCursor++] = hash;

        if (this.mode !== DbMode.Volatile) {
            this.lib.symbols.wal_append_typed_frame(
                this.ensureWalFd(),
                FRAME_RELATIONS,
                ((ptr(this.ramBuffer) as unknown as number) + startOffset) as any,
                8,
                this.mode,
                1
            );
        }
    }

    public removeArticle(articleId: number) {
        if (articleId < 0 || articleId >= MAX_ARTICLES) return;
        this.deletedBits[articleId >>> 5] |= 1 << (articleId & 31);
        if (this.mode !== DbMode.Volatile) {
            this.singleU32Scratch[0] = articleId >>> 0;
            this.lib.symbols.wal_append_typed_frame(
                this.ensureWalFd(),
                FRAME_DELETE_ARTICLE,
                ptr(this.singleU32Scratch) as any,
                4,
                this.mode,
                1
            );
        }
    }

    public removeKeyword(articleId: number, word: string) {
        if (articleId < 0 || articleId >= MAX_ARTICLES) return;
        if (this.ramCursor + 2 > MAX_RAM_BUFFER) {
            this.merge();
        }
        const tombstoneId = (articleId | TOMBSTONE_BIT) >>> 0;
        const hash = hashKeyword(word);
        const startOffset = this.ramCursor * 4;
        this.ramBuffer[this.ramCursor++] = tombstoneId;
        this.ramBuffer[this.ramCursor++] = hash;
        if (this.mode !== DbMode.Volatile) {
            this.lib.symbols.wal_append_typed_frame(
                this.ensureWalFd(),
                FRAME_RELATIONS,
                ((ptr(this.ramBuffer) as unknown as number) + startOffset) as any,
                8,
                this.mode,
                1
            );
        }
    }

    public merge() {
        if (this.isSearching) return;

        const nextMmapRelations = new Uint32Array(this.mmapCursor + this.ramCursor);
        const resultLen = Number(
            this.lib.symbols.merge_database_compact(
                this.mmapCursor > 0 ? ptr(this.mmapRelations) : ptr(this.dummyU32),
                this.mmapCursor,
                this.ramCursor > 0 ? ptr(this.ramBuffer) : ptr(this.dummyU32),
                this.ramCursor,
                ptr(this.deletedBits),
                ptr(this.upsertedBits),
                nextMmapRelations.length > 0 ? ptr(nextMmapRelations) : ptr(this.dummyU32)
            )
        );

        this.mmapRelations = nextMmapRelations.subarray(0, resultLen);
        this.mmapCursor = resultLen;
        this.ramCursor = 0;

        if (this.mode !== DbMode.Volatile) {
            this.lib.symbols.atomic_write_file(
                this.mmapCursor > 0 ? ptr(this.mmapRelations) : ptr(this.dummyU32),
                this.mmapCursor * 4,
                ptr(this.cDbTmpPath),
                ptr(this.cDbPath),
                this.mode
            );
            this.lib.symbols.wal_truncate(this.ensureWalFd(), this.mode);
        }
    }

    public search(keywords: string[], exclude: number[] = [], topK: number = 3): NerveMatch[] {
        if (this.isSearching || (this.mmapCursor === 0 && this.ramCursor === 0) || keywords.length === 0) {
            return [];
        }
        this.isSearching = true;

        try {
            const qLen = Math.min(keywords.length, this.queryScratch.length);
            for (let i = 0; i < qLen; i++) {
                this.queryScratch[i] = hashKeyword(keywords[i]);
            }

            const exLen = Math.min(exclude.length, this.excludeScratch.length);
            for (let i = 0; i < exLen; i++) {
                this.excludeScratch[i] = exclude[i];
            }

            const effTopK = Math.min(topK, MAX_TOP_K);

            this.lib.symbols.process_query_sorted_unique(
                this.mmapCursor > 0 ? ptr(this.mmapRelations) : ptr(this.dummyU32),
                this.mmapCursor,
                this.ramCursor > 0 ? ptr(this.ramBuffer) : ptr(this.dummyU32),
                this.ramCursor,
                qLen > 0 ? ptr(this.queryScratch) : ptr(this.dummyU32),
                qLen,
                exLen > 0 ? ptr(this.excludeScratch) : ptr(this.dummyU32),
                exLen,
                ptr(this.deletedBits),
                ptr(this.upsertedBits),
                ptr(this.scoreBuffer),
                ptr(this.resultBuffer),
                effTopK
            );

            const results: NerveMatch[] = [];
            for (let i = 0; i < effTopK; i++) {
                const score = this.resultBuffer[i * 2 + 1] ?? 0;
                if (score === 0) break;
                results.push({ id: this.resultBuffer[i * 2] ?? 0, score });
            }
            return results;
        } finally {
            this.isSearching = false;
        }
    }

    public storeText(articleId: number, title: string, content: string) {
        const currentOffset = existsSync(this.textPath) ? readFileSync(this.textPath).byteLength : 0;
        const fullText = `TITLE: ${title}\n\n${content}`;
        const buf = Buffer.from(fullText);

        appendFileSync(this.textPath, buf);

        const indexEntry = new Uint32Array([articleId, currentOffset, buf.length]);
        appendFileSync(this.textIndexPath, Buffer.from(indexEntry.buffer));

        this.loadDatabase();
    }

    public getText(articleId: number): string {
        if (this.textsMMap.length === 0 || this.textsIndex.length === 0) return "";

        const textPtr = this.lib.symbols.get_article_text(
            ptr(this.textsMMap), this.textsMMap.length,
            ptr(this.textsIndex), this.textsIndex.length,
            ptr(this.deletedBits),
            articleId
        );

        if (textPtr === 0 || textPtr === null) return "";

        const text = new CString(textPtr as any).toString();
        this.lib.symbols.free_article_text(textPtr);
        return text;
    }
}
