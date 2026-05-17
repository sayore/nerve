// test/perf_test.ts
import { Engine, DungeonPath } from "../packages/nerve-bun/src/engine";
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(import.meta.dir, "../db/changes.log.bin");
const DB_PATH = join(import.meta.dir, "../db/sorted.bin");
const DB_DIR = join(import.meta.dir, "../db");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR);
if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH);
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

console.log("--- Performance Test: Semantic Dungeon Crawler ---");

const ARTICLE_COUNT = 100_000;
const KEYWORDS_PER_ARTICLE = 10;
const TOTAL_RELATIONS = ARTICLE_COUNT * KEYWORDS_PER_ARTICLE;

console.log(`Setup: Generating ${TOTAL_RELATIONS} relations...`);
const texts: string[] = [];
const textIndex: number[] = [];
let currentOffset = 0;

for (let i = 0; i < ARTICLE_COUNT; i++) {
    for (let k = 0; k < KEYWORDS_PER_ARTICLE; k++) {
        Engine.addKeyword(i, `word_${k}_${i % 100}`);
    }
    
    // Generate dummy text
    const content = `Dies ist der Inhalt von Artikel #${i}. Er enthält wichtige Informationen über das Wissens-Netzwerk Nerve. Hier sind einige Keywords: word_1_${i%100}, word_2_${i%100}.`;
    const buf = Buffer.from(content);
    texts.push(content);
    textIndex.push(i, currentOffset, buf.length);
    currentOffset += buf.length;
}

// Persist texts and index
const TEXT_PATH = join(DB_DIR, "texts.bin");
const TEXT_INDEX_PATH = join(DB_DIR, "texts_index.bin");
writeFileSync(TEXT_PATH, Buffer.from(texts.join('')));
writeFileSync(TEXT_INDEX_PATH, new Uint32Array(textIndex));

Engine.triggerAsyncMerge();

const dungeon = new DungeonPath();
const startKeywords = ["word_1_5", "word_2_5", "word_3_5"];
const startId = 5;

console.log("\n--- Testing Dungeon Path Locking ---");

const startLock = performance.now();
// Lock first node
const matches1 = await dungeon.lockNode(startId, startKeywords);
const endLock1 = performance.now();
console.log(`Locking first node took ${(endLock1 - startLock).toFixed(4)}ms`);
console.log(`Floating nodes around Article #${startId}:`, matches1.length);

// Lock second node (which has overlapping keywords)
const secondId = 105;
const secondKeywords = ["word_1_5", "word_4_5", "word_5_5"];
const startLock2 = performance.now();
const matches2 = await dungeon.lockNode(secondId, secondKeywords);
const endLock2 = performance.now();

console.log(`Locking second node took ${(endLock2 - startLock2).toFixed(4)}ms`);
console.log(`Intersection keywords:`, dungeon.currentKeywords);
console.log(`New floating nodes:`, matches2.length);

// Verify no duplicates
const lockedIds = dungeon.lockedNodes;
const duplicateFound = matches2.some(m => lockedIds.includes(m.id));
if (!duplicateFound) {
    console.log("SUCCESS: No duplicate articles in floating nodes.");
} else {
    console.log("ERROR: Duplicate articles found!");
}

const iterations = 1000;
let totalTime = 0;
const testExclude = [5, 105, 205];
const testKeywords = ["word_1_5", "word_2_5"];

for (let i = 0; i < iterations; i++) {
    const s = performance.now();
    Engine.getTopMatchesUnique(testKeywords, testExclude);
    totalTime += (performance.now() - s);
}
console.log(`\nAverage Unique Search Time (1M+ relations, ${iterations} runs): ${(totalTime / iterations).toFixed(4)}ms`);
