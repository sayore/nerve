// src/index.ts
import { BrowserWindow, BrowserView } from "electrobun/bun";
import { Engine, DungeonPath, type NerveRPCSchema } from "nerve-bun";

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
                getArticleText: async ({ articleId }) => {
                    return Engine.getArticleText(articleId);
                },
                getInitialMatches: async ({ keywords }) => {
                    const searchTerms = keywords.length > 0 ? keywords : ["word_1_5", "word_2_5"];
                    return Engine.getTopMatchesUnique(searchTerms, []);
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
