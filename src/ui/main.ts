// src/ui/main.ts
import { Electroview } from "electrobun/view";
import { type NerveRPCSchema } from "../types";

const rpc = Electroview.defineRPC<NerveRPCSchema>({
    handlers: {
        requests: {},
        messages: {}
    }
});

const electroview = new Electroview({ rpc });

const contentEl = document.getElementById('content')!;
const matchesEl = document.getElementById('matches')!;

let currentArticleId = 1;

function renderText(text: string) {
    contentEl.innerHTML = text.split(/\s+/).map(word => {
        const clean = word.replace(/[^a-zA-Zäöüß]/g, "").toLowerCase();
        return `<span class="w" data-word="${clean}">${word}</span>`;
    }).join(' ');
}

contentEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('w')) {
        const word = target.getAttribute('data-word')!;
        
        // RPC-Call an den Bun-Main-Prozess
        electroview.rpc.send.addKeyword({ articleId: currentArticleId, word });
        
        target.classList.add('is-keyword');
        await updateMatches();
    }
});

async function updateMatches() {
    const keywords = Array.from(document.querySelectorAll('.is-keyword'))
        .map(el => (el as HTMLElement).getAttribute('data-word')!);
    
    if (keywords.length === 0) return;

    const matches = await electroview.rpc.request.getTopMatches({ keywords });
    
    matchesEl.innerHTML = matches.map((m: any) => `
        <div class="match">
            <strong>Article #${m.id}</strong><br>
            Score: ${m.score}
        </div>
    `).join('');
}

// Initialer Text
renderText("Das ist ein Test für das Nerve Wissens-Netzwerk. Klicke auf Wörter um sie als Keywords zu markieren.");
