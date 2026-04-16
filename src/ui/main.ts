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

const nodesContainer = document.getElementById('nodes-container')!;
const articleContent = document.getElementById('article-content')!;
const svgConnections = document.getElementById('connections')! as unknown as SVGSVGElement;

let currentArticleId = 0;
const lockedNodes: { id: number; el: HTMLElement; x: number; y: number }[] = [];
const SQRT3 = Math.sqrt(3);

const hexOffsets = [
    { x: 1, y: 0 }, { x: 0.5, y: SQRT3/2 }, { x: -0.5, y: SQRT3/2 },
    { x: -1, y: 0 }, { x: -0.5, y: -SQRT3/2 }, { x: 0.5, y: -SQRT3/2 }
];

async function init() {
    renderText("Willkommen im Nerve-Dungeon. Klicke auf Wörter, um Keywords zu definieren, oder wähle einen der schwebenden Artikel aus.");
    const initialKeywords = ["wissen", "daten", "rust"]; // Mock initial keywords
    const matches = await electroview.rpc.request.getInitialMatches({ keywords: initialKeywords });
    renderFloatingNodes(matches);
}

function renderText(text: string) {
    articleContent.innerHTML = text.split(/\s+/).map(word => {
        const clean = word.replace(/[^a-zA-Zäöüß]/g, "").toLowerCase();
        return `<span class="w" data-word="${clean}">${word}</span>`;
    }).join(' ');
}

function renderFloatingNodes(matches: { id: number; score: number }[]) {
    // Clear existing floating nodes
    document.querySelectorAll('.floating').forEach(el => el.remove());

    matches.forEach((m, i) => {
        const offset = hexOffsets[i % 6];
        const dist = 350;
        const x = window.innerWidth / 2 + offset.x * dist - 75;
        const y = window.innerHeight / 2 + offset.y * dist - 86;

        const el = document.createElement('div');
        el.className = 'node floating';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.innerHTML = `Article #${m.id}<br>Rel: ${m.score}`;
        el.onclick = () => lockNode(m.id, x, y);
        nodesContainer.appendChild(el);
    });
}

async function lockNode(articleId: number, x: number, y: number) {
    // 1. Get keywords for this article
    const keywords = await electroview.rpc.request.getKeywordsForArticle({ articleId });
    
    // 2. Lock it in the dungeon state
    const matches = await electroview.rpc.request.lockNode({ articleId, keywords });
    
    // 3. Update UI
    const el = document.createElement('div');
    el.className = 'node locked';
    // Center it somewhat or leave it where it was clicked
    const centerX = window.innerWidth / 2 + (lockedNodes.length * 40) - 75;
    const centerY = window.innerHeight / 2 - 250 - 86; 
    
    el.style.left = `${centerX}px`;
    el.style.top = `${centerY}px`;
    el.innerHTML = `LOCKED<br>Article #${articleId}`;
    nodesContainer.appendChild(el);
    
    lockedNodes.push({ id: articleId, el, x: centerX, y: centerY });
    
    // 4. Draw connection
    if (lockedNodes.length > 1) {
        const prev = lockedNodes[lockedNodes.length - 2];
        drawLine(prev.x + 75, prev.y + 86, centerX + 75, centerY + 86);
    }
    
    // 5. Update text and floating nodes
    renderText(`Du bist nun in Raum Article #${articleId}. Die Schnittmenge hat dich hierher geführt. Suche weiter nach der Wahrheit.`);
    renderFloatingNodes(matches);
}

function drawLine(x1: number, y1: number, x2: number, y2: number) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toString());
    line.setAttribute("y1", y1.toString());
    line.setAttribute("x2", x2.toString());
    line.setAttribute("y2", y2.toString());
    line.setAttribute("stroke", "#0f0");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "5,5");
    svgConnections.appendChild(line);
}

init();
