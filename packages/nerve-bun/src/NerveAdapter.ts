import { ptr, dlopen, FFIType, CString } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface NerveMatch {
    id: number;
    score: number;
}

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
    private logPath: string;
    private textPath: string;
    private textIndexPath: string;
    
    private mmapRelations: Uint32Array = new Uint32Array(0);
    private mmapCursor: number = 0;
    private ramBuffer: Uint32Array;
    private ramCursor: number = 0;
    private MAX_RAM_BUFFER = 100000;
    
    private scoreBuffer = new Uint32Array(1000000);
    private resultBuffer = new Uint32Array(6);
    private dummyU32 = new Uint32Array(1);
    
    private textsMMap: Uint8Array = new Uint8Array(0);
    private textsIndex: Uint32Array = new Uint32Array(0);
    
    private isSearching = false;

    constructor(basePath: string = "db/ai") {
        const fullBasePath = join(process.cwd(), basePath);
        if (!existsSync(fullBasePath)) {
            mkdirSync(fullBasePath, { recursive: true });
        }
        
        this.dbPath = join(fullBasePath, "sorted.bin");
        this.logPath = join(fullBasePath, "changes.log.bin");
        this.textPath = join(fullBasePath, "texts.bin");
        this.textIndexPath = join(fullBasePath, "texts_index.bin");
        
        this.ramBuffer = new Uint32Array(this.MAX_RAM_BUFFER);
        
        const libPath = getLibPath();
        const sz = FFIType.u64;
        this.lib = dlopen(libPath, {
            get_article_text: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.u32],
                returns: FFIType.ptr
            },
            free_article_text: {
                args: [FFIType.ptr],
                returns: FFIType.void
            },
            process_query_sorted_unique: { 
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr, FFIType.ptr, FFIType.u64], 
                returns: FFIType.void 
            },
            intersect_keywords: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr],
                returns: sz
            },
            merge_database: {
                args: [FFIType.ptr, sz, FFIType.ptr, sz, FFIType.ptr],
                returns: sz
            }
        });
        
        this.loadDatabase();
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
    }

    public addKeyword(articleId: number, word: string) {
        // Fix: Lowercase normalization for queries
        const normalizedWord = word.toLowerCase();
        const hash = Number(BigInt.asUintN(32, Bun.hash(normalizedWord) as bigint));
        this.ramBuffer[this.ramCursor++] = articleId;
        this.ramBuffer[this.ramCursor++] = hash;
        
        const entry = new Uint32Array([articleId, hash]); 
        appendFileSync(this.logPath, Buffer.from(entry.buffer));
        
        if (this.ramCursor >= this.MAX_RAM_BUFFER) {
            this.merge();
        }
    }

    public merge() {
        if (this.isSearching || this.ramCursor === 0) return;
        
        const nextMmapRelations = new Uint32Array(this.mmapCursor + this.ramCursor);
        const resultLen = this.lib.symbols.merge_database(
            ptr(this.mmapRelations.length > 0 ? this.mmapRelations : this.dummyU32), this.mmapCursor,
            ptr(this.ramBuffer), this.ramCursor,
            ptr(nextMmapRelations)
        );
        
        this.mmapRelations = nextMmapRelations;
        this.mmapCursor = Number(resultLen);
        this.ramCursor = 0;
        
        // Fix: Attempt atomic merge write (temp file + rename) plan.
        const tempDbPath = this.dbPath + ".tmp";
        writeFileSync(tempDbPath, Buffer.from(this.mmapRelations.buffer));
        import("node:fs").then(fs => fs.renameSync(tempDbPath, this.dbPath));
        writeFileSync(this.logPath, Buffer.from([]));
    }

    public search(keywords: string[], exclude: number[] = [], topK: number = 3): NerveMatch[] {
        if (this.isSearching) return [];
        this.isSearching = true;
        
        try {
            // Fix: Lowercase normalization
            const hashes = new Uint32Array(keywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w.toLowerCase()) as bigint))));
            const excludeBuffer = new Uint32Array(exclude);
            const dynamicResultBuffer = new Uint32Array(topK * 2);
            
            this.lib.symbols.process_query_sorted_unique(
                ptr(this.mmapRelations.length > 0 ? this.mmapRelations : this.dummyU32), this.mmapCursor,
                ptr(hashes.length > 0 ? hashes : this.dummyU32), hashes.length,
                ptr(excludeBuffer.length > 0 ? excludeBuffer : this.dummyU32), excludeBuffer.length,
                ptr(this.scoreBuffer), ptr(dynamicResultBuffer), topK
            );
            
            const results: NerveMatch[] = [];
            for (let i = 0; i < topK; i++) {
                const id = dynamicResultBuffer[i * 2] ?? 0;
                const score = dynamicResultBuffer[i * 2 + 1] ?? 0;
                if (score > 0) results.push({ id, score });
            }
            return results;
        } finally {
            this.isSearching = false;
        }
    }

    public storeText(articleId: number, title: string, content: string) {
        let currentOffset = existsSync(this.textPath) ? readFileSync(this.textPath).byteLength : 0;
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
            articleId
        );
        
        if (textPtr === 0 || textPtr === null) return "";
        
        const text = new CString(textPtr as any).toString();
        this.lib.symbols.free_article_text(textPtr);
        return text;
    }
}