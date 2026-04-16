// src/types.ts
export type NerveRPCSchema = {
    bun: {
        requests: {
            getTopMatches: {
                params: { keywords: string[] };
                response: { id: number; score: number }[];
            };
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
