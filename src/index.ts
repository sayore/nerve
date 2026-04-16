// src/index.ts
import { BrowserWindow, BrowserView } from "electrobun/bun";
import { Engine } from "./engine";
import { type NerveRPCSchema } from "./types";
import { join } from "node:path";

const win = new BrowserWindow({
    title: "Nerve",
    width: 1000,
    height: 800,
    url: "views://main/index.html",
    rpc: BrowserView.defineRPC<NerveRPCSchema>({
        handlers: {
            requests: {
                getTopMatches: ({ keywords }) => {
                    return Engine.getTopMatches(keywords);
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

console.log("Nerve Engine started.");
