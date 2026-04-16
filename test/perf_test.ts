// test/perf_test.ts
import { Engine } from "../src/engine";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(import.meta.dir, "../db/changes.log.bin");

// Cleanup log for clean test
if (existsSync(LOG_PATH)) {
    unlinkSync(LOG_PATH);
}

console.log("--- Performance Test: Nerve Engine ---");

const ARTICLE_COUNT = 100_000;
const KEYWORDS_PER_ARTICLE = 10;
const TOTAL_RELATIONS = ARTICLE_COUNT * KEYWORDS_PER_ARTICLE;

console.log(`Setup: Generating ${TOTAL_RELATIONS} relations...`);

const startSetup = performance.now();
for (let i = 0; i < ARTICLE_COUNT; i++) {
    for (let k = 0; k < KEYWORDS_PER_ARTICLE; k++) {
        Engine.addKeyword(i, `word_${k}_${i % 100}`); // Simulated words
    }
}
const endSetup = performance.now();
console.log(`Setup finished in ${(endSetup - startSetup).toFixed(2)}ms`);

const activeKeywords = ["word_1_5", "word_2_5", "word_3_5", "word_4_5", "word_5_5"];
const hashes = new Uint32Array(activeKeywords.map(w => Number(BigInt.asUintN(32, Bun.hash(w) as bigint))));

console.log(`Search: Finding matches for ${activeKeywords.join(", ")}...`);

// Warmup
Engine.searchRaw(hashes);

const iterations = 1000;
let totalTime = 0;

for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    Engine.searchRaw(hashes);
    totalTime += (performance.now() - start);
}

console.log(`Average Search Time (over ${iterations} runs): ${(totalTime / iterations).toFixed(4)}ms`);
const results = Engine.searchRaw(hashes);
console.log("Top Matches:", results);

// Small validation
if (results.length > 0) {
    console.log("SUCCESS: Matches found.");
} else {
    console.log("WARNING: No matches found. Check logic.");
}
