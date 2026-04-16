// src/types.ts
export type NerveRPCSchema = {
    bun: {
        requests: {
            lockNode: {
                params: { articleId: number; keywords: string[] };
                response: { id: number; score: number }[];
            };
            getKeywordsForArticle: {
                params: { articleId: number };
                response: string[];
            };
            getInitialMatches: {
                params: { keywords: string[] };
                response: { id: number; score: number }[];
            }
        };
        messages: {
            addKeyword: { articleId: number; word: string };
        };
    };
    webview: {
        requests: {};
        messages: {};
    };
};
