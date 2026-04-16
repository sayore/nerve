// src/index.ts
import { BrowserWindow, BrowserView } from "electrobun/bun";
import { Engine, DungeonPath } from "./engine";
import { type NerveRPCSchema } from "./types";

const dungeon = new DungeonPath();

const win = new BrowserWindow({
    title: "Nerve",
    width: 1280,
    height: 900,
    url: "views://main/index.html",
    rpc: BrowserView.defineRPC<NerveRPCSchema>({
        handlers: {
            requests: {
                lockNode: async ({ articleId, keywords }) => {
                    return dungeon.lockNode(articleId, keywords);
                },
                unlockNode: async ({ index }) => {
                    return dungeon.unlockNode(index);
                },
                getKeywordsForArticle: async ({ articleId }) => {
                    return Engine.getKeywordsForArticle(articleId);
                },
                getInitialMatches: async ({ keywords }) => {
                    return Engine.getTopMatchesUnique(keywords, []);
                }
            },
            messages: {
                addKeyword: ({ articleId, word }) => {
                    Engine.addKeyword(articleId, word);
                }
            }
        }
    })
});

console.log("Nerve Engine started (Dungeon Mode).");
