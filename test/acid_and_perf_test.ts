// test/acid_and_perf_test.ts
import { Engine, DungeonPath, DbMode, hashKeyword } from "../packages/nerve-bun/src/engine";
import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dir, "..");
const DB_DIR = join(ROOT_DIR, "db");
const LOG_PATH = join(DB_DIR, "changes.log.bin");
const DB_PATH = join(DB_DIR, "sorted.bin");
const TMP_PATH = join(DB_DIR, "sorted.bin.tmp");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

function cleanDbFiles() {
    Engine.reset();
    if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH);
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);
}

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

const results: TestResult[] = [];
function assertTest(name: string, condition: boolean, detail: string) {
    results.push({ name, passed: condition, detail });
    const tag = condition ? "PASS" : "FAIL";
    console.log(`[${tag}] ${name}: ${detail}`);
}

console.log("=== 1. Korrektheit & Floating Nodes (DungeonPath) + Deduplizierung ===");
cleanDbFiles();
Engine.setMode(DbMode.FastWal);

const ARTICLE_COUNT = 100_000;
const KEYWORDS_PER_ARTICLE = 10;
const TOTAL_RELATIONS = ARTICLE_COUNT * KEYWORDS_PER_ARTICLE;

Engine.beginTransaction();
for (let i = 0; i < ARTICLE_COUNT; i++) {
    for (let k = 0; k < KEYWORDS_PER_ARTICLE; k++) {
        Engine.addKeyword(i, `word_${k}_${i % 100}`);
    }
}
Engine.commitTransaction();
Engine.triggerAsyncMerge();

const sizeAfterRun1 = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
assertTest(
    "sorted.bin Größe (1M Relationen)",
    sizeAfterRun1 === 8_000_000,
    `${sizeAfterRun1} Bytes (erwartet: 8000000)`
);

// Zweiter Lauf OHNE Engine.reset() / unlinkSync -> Deduplizierung muss Größe bei 8.000.000 Bytes halten
Engine.beginTransaction();
for (let i = 0; i < ARTICLE_COUNT; i++) {
    for (let k = 0; k < KEYWORDS_PER_ARTICLE; k++) {
        Engine.addKeyword(i, `word_${k}_${i % 100}`);
    }
}
Engine.commitTransaction();
Engine.triggerAsyncMerge();

const sizeAfterRun2 = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
assertTest(
    "sorted.bin Deduplizierung (2. Lauf ohne Löschen)",
    sizeAfterRun2 === 8_000_000,
    `${sizeAfterRun2} Bytes (erwartet: 8000000)`
);

const dungeon = new DungeonPath();
const matches1 = await dungeon.lockNode(5, ["word_1_5", "word_2_5", "word_3_5"]);
const matches2 = await dungeon.lockNode(105, ["word_1_5", "word_4_5", "word_5_5"]);
const noDuplicates = !matches2.some(m => dungeon.lockedNodes.includes(m.id));
const rawHashDirect = Engine.getTopMatchesUnique(dungeon.currentKeywords, dungeon.lockedNodes);

assertTest(
    "DungeonPath lockNode(5) Floating Nodes > 0",
    matches1.length > 0 && !matches1.some(m => m.id === 5),
    `count=${matches1.length}`
);
assertTest(
    "DungeonPath lockNode(105) Floating Nodes > 0 & keine Duplikate",
    matches2.length > 0 && noDuplicates,
    `count=${matches2.length}, intersection=${JSON.stringify(dungeon.currentKeywords)}`
);
assertTest(
    "hash_<wert> kein Doppel-Hashing",
    rawHashDirect.length > 0 && hashKeyword(`hash_${hashKeyword("word_1_5")}`) === hashKeyword("word_1_5"),
    `matches via "hash_..."=${rawHashDirect.length}`
);

console.log("\n=== 2. Modus-Vergleich (1.000.000 Relationen + 1.000 Einzel-Writes + 1.000 Searches) ===");
interface BenchRow {
    mode: string;
    seedMs: number;
    singleWriteUs: number;
    searchUs: number;
    dbBytes: number;
}
const benchRows: BenchRow[] = [];

const modes: { name: string; mode: DbMode }[] = [
    { name: "DbMode.Volatile", mode: DbMode.Volatile },
    { name: "DbMode.FastWal", mode: DbMode.FastWal },
    { name: "DbMode.StrictAcid", mode: DbMode.StrictAcid },
];

for (const { name, mode } of modes) {
    cleanDbFiles();
    Engine.setMode(mode);

    // 2a. Batch-Seeding (1.000.000 Relationen)
    const tSeedStart = performance.now();
    Engine.beginTransaction();
    for (let i = 0; i < ARTICLE_COUNT; i++) {
        for (let k = 0; k < KEYWORDS_PER_ARTICLE; k++) {
            Engine.addKeyword(i, `word_${k}_${i % 100}`);
        }
    }
    Engine.commitTransaction();
    Engine.triggerAsyncMerge();
    const seedMs = performance.now() - tSeedStart;

    // 2b. Einzel-Write-Latenz (1.000 einzelne addKeyword-Calls ohne Transaktion)
    const SINGLE_WRITES = 1000;
    const tSingleStart = performance.now();
    for (let i = 0; i < SINGLE_WRITES; i++) {
        Engine.addKeyword(500_000 + i, `single_kw_${i}`);
    }
    const singleWriteUs = ((performance.now() - tSingleStart) * 1000) / SINGLE_WRITES;

    // 2c. Search-Latenz (1.000 Läufe getTopMatchesUnique)
    const SEARCH_RUNS = 1000;
    const testExclude = [5, 105, 205];
    const testKeywords = ["word_1_5", "word_2_5"];
    // Warmup
    Engine.getTopMatchesUnique(testKeywords, testExclude);
    const tSearchStart = performance.now();
    for (let i = 0; i < SEARCH_RUNS; i++) {
        Engine.getTopMatchesUnique(testKeywords, testExclude);
    }
    const searchUs = ((performance.now() - tSearchStart) * 1000) / SEARCH_RUNS;

    const dbBytes = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
    benchRows.push({ mode: name, seedMs, singleWriteUs, searchUs, dbBytes });
}

console.log("\n=== 3. ACID- & Crash-Recovery-Tests ===");

// 3a. Read-Your-Own-Writes Test (ungemergte Daten im ramBuffer bei mmapCursor === 0)
cleanDbFiles();
Engine.setMode(DbMode.FastWal);
Engine.addKeyword(42, "unmerged_ryow_kw");
const ryowMatches = Engine.getTopMatchesUnique(["unmerged_ryow_kw"], []);
assertTest(
    "Read-Your-Own-Writes (ungemergter ramBuffer bei mmapCursor === 0)",
    ryowMatches.length === 1 && ryowMatches[0].id === 42 && ryowMatches[0].score === 1,
    `matches=${JSON.stringify(ryowMatches)}`
);

// 3b. Rollback-Test
cleanDbFiles();
Engine.setMode(DbMode.FastWal);
Engine.beginTransaction();
for (let i = 0; i < 100; i++) {
    Engine.addKeyword(i, "rollback_only_kw");
}
Engine.rollbackTransaction();
Engine.triggerAsyncMerge();
const rollbackMatches = Engine.getTopMatchesUnique(["rollback_only_kw"], []);
const walSizeAfterRollback = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
const dbSizeAfterRollback = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
assertTest(
    "Rollback-Test (keine Daten im RAM oder auf Disk)",
    rollbackMatches.length === 0 && walSizeAfterRollback === 0 && dbSizeAfterRollback === 0,
    `matches=${rollbackMatches.length} (${JSON.stringify(rollbackMatches)}), walBytes=${walSizeAfterRollback}, dbBytes=${dbSizeAfterRollback}`
);

// 3b. Simulated Process Crash (SIGKILL)
cleanDbFiles();
const crashWriterScript = `
import { Engine, DbMode } from "./packages/nerve-bun/src/engine";
Engine.setMode(DbMode.FastWal);
Engine.beginTransaction();
for (let i = 0; i < 1000; i++) {
    for (let k = 0; k < 10; k++) {
        Engine.addKeyword(i, "crash_kw_" + k + "_" + (i % 10));
    }
}
Engine.commitTransaction();
process.kill(process.pid, "SIGKILL");
`;
const crashProc = Bun.spawnSync(["bun", "-e", crashWriterScript], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
});

const dbExistsPreRecovery = existsSync(DB_PATH);
const walSizePreRecovery = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;

const crashVerifyScript = `
import { Engine } from "./packages/nerve-bun/src/engine";
const m = Engine.getTopMatchesUnique(["crash_kw_0_5", "crash_kw_1_5"], []);
console.log(JSON.stringify({ count: m.length, topScore: m[0]?.score ?? 0 }));
`;
const crashVerifyProc = Bun.spawnSync(["bun", "-e", crashVerifyScript], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
});
const crashVerifyOut = crashVerifyProc.stdout.toString().trim();
let crashParsed = { count: 0, topScore: 0 };
try { crashParsed = JSON.parse(crashVerifyOut); } catch {}
const dbSizePostRecovery = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;

assertTest(
    "Simulated Process Crash (SIGKILL) & WAL-Recovery",
    crashProc.signalCode === "SIGKILL" &&
        !dbExistsPreRecovery &&
        walSizePreRecovery > 0 &&
        crashParsed.count > 0 &&
        crashParsed.topScore === 2 &&
        dbSizePostRecovery === 80_000,
    `signal=${crashProc.signalCode}, walBytesBefore=${walSizePreRecovery}, recoveredMatches=${crashParsed.count}, topScore=${crashParsed.topScore}, sortedBytesAfter=${dbSizePostRecovery}`
);

// 3c. Corrupt Tail-Frame Test (7 Garbage-Bytes anhängen)
cleanDbFiles();
const tailWriterScript = `
import { Engine, DbMode } from "./packages/nerve-bun/src/engine";
Engine.setMode(DbMode.FastWal);
Engine.beginTransaction();
for (let i = 0; i < 100; i++) {
    for (let k = 0; k < 10; k++) {
        Engine.addKeyword(i, "tail_kw_" + k);
    }
}
Engine.commitTransaction();
process.exit(0);
`;
Bun.spawnSync(["bun", "-e", tailWriterScript], { cwd: ROOT_DIR, stdout: "pipe", stderr: "pipe" });
appendFileSync(LOG_PATH, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x13, 0x37, 0x42]));

const tailVerifyScript = `
import { Engine } from "./packages/nerve-bun/src/engine";
const m = Engine.getTopMatchesUnique(["tail_kw_0", "tail_kw_1"], []);
console.log(JSON.stringify({ count: m.length, topScore: m[0]?.score ?? 0 }));
`;
const tailVerifyProc = Bun.spawnSync(["bun", "-e", tailVerifyScript], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
});
let tailParsed = { count: 0, topScore: 0 };
try { tailParsed = JSON.parse(tailVerifyProc.stdout.toString().trim()); } catch {}
const dbSizeAfterTail = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
const walSizeAfterTail = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;

assertTest(
    "Corrupt Tail-Frame Test (7 Garbage-Bytes verworfen)",
    tailParsed.count > 0 && tailParsed.topScore === 2 && dbSizeAfterTail === 8_000 && walSizeAfterTail === 0,
    `recoveredMatches=${tailParsed.count}, topScore=${tailParsed.topScore}, sortedBytes=${dbSizeAfterTail}, walBytesAfter=${walSizeAfterTail}`
);

// 3e. Tombstone Deletes (removeArticle & removeKeyword) + Compaction
cleanDbFiles();
Engine.setMode(DbMode.FastWal);
Engine.beginTransaction();
Engine.addKeyword(10, "alpha");
Engine.addKeyword(10, "beta");
Engine.addKeyword(20, "alpha");
Engine.addKeyword(20, "gamma");
Engine.commitTransaction();
Engine.triggerAsyncMerge();

Engine.removeKeyword(10, "beta");
const afterRemoveKwPreMerge = Engine.getTopMatchesUnique(["beta"], []);
Engine.removeArticle(20);
const afterRemoveArtPreMerge = Engine.getTopMatchesUnique(["gamma"], []);
Engine.triggerAsyncMerge();
const afterCompactAlpha = Engine.getTopMatchesUnique(["alpha"], []);
const sizeAfterCompact = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;

assertTest(
    "Tombstones (removeKeyword & removeArticle + Compaction)",
    afterRemoveKwPreMerge.length === 0 &&
        afterRemoveArtPreMerge.length === 0 &&
        afterCompactAlpha.length === 1 &&
        afterCompactAlpha[0].id === 10 &&
        sizeAfterCompact === 8,
    `preMergeBeta=${afterRemoveKwPreMerge.length}, preMergeArt20=${afterRemoveArtPreMerge.length}, postCompact=${JSON.stringify(afterCompactAlpha)}, sortedBytes=${sizeAfterCompact}`
);

// 3f. Atomarer Upsert (upsertArticle: Text + Relationen + alte Relationen weg + Crash-Recovery)
cleanDbFiles();
Engine.setMode(DbMode.FastWal);
Engine.upsertArticle(42, "Alter Text 42", ["old_kw", "shared_kw"]);
Engine.triggerAsyncMerge();

Engine.upsertArticle(42, "Neuer Text 42", ["new_kw", "shared_kw"]);
const oldKwPreMerge = Engine.getTopMatchesUnique(["old_kw"], []);
const newKwPreMerge = Engine.getTopMatchesUnique(["new_kw", "shared_kw"], []);
const textPreMerge = Engine.getArticleText(42);
Engine.triggerAsyncMerge();
const oldKwPostMerge = Engine.getTopMatchesUnique(["old_kw"], []);
const newKwPostMerge = Engine.getTopMatchesUnique(["new_kw", "shared_kw"], []);
const textPostMerge = Engine.getArticleText(42);

assertTest(
    "Atomarer Upsert (upsertArticle vor & nach Merge)",
    oldKwPreMerge.length === 0 &&
        newKwPreMerge.length === 1 &&
        newKwPreMerge[0].score === 2 &&
        textPreMerge === "Neuer Text 42" &&
        oldKwPostMerge.length === 0 &&
        newKwPostMerge.length === 1 &&
        newKwPostMerge[0].score === 2 &&
        textPostMerge === "Neuer Text 42",
    `oldPost=${oldKwPostMerge.length}, newPost=${JSON.stringify(newKwPostMerge)}, text="${textPostMerge}"`
);

console.log("\n=== Benchmark-Tabelle ===");
console.log("| Modus | Seeding (1M Rel.) | Einzel-Write (Ø 1.000) | Search (Ø 1.000) | sorted.bin |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const r of benchRows) {
    console.log(
        `| ${r.mode} | ${r.seedMs.toFixed(2)} ms | ${r.singleWriteUs.toFixed(3)} µs | ${r.searchUs.toFixed(3)} µs | ${r.dbBytes} B |`
    );
}

const failed = results.filter(r => !r.passed).length;
console.log(`\nGesamt: ${results.length - failed}/${results.length} Tests bestanden.`);
if (failed > 0) process.exit(1);
