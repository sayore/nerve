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
    renderText("Willkommen im Nerve-Dungeon. Klicke auf schwebende Hexagons, um tiefer in die Wissens-Schnittmenge einzudringen. Nutze 'Locked Nodes', um den Pfad zu verengen oder durch Klick zu löschen.");
    const initialKeywords = ["wissen", "daten", "rust"]; 
    const matches = await electroview.rpc.request.getInitialMatches({ keywords: initialKeywords });
    renderFloatingNodes(matches);
}

function renderText(text: string) {
    articleContent.innerHTML = text.split(/\s+/).map(word => {
        const clean = word.replace(/[^a-zA-Zäöüß]/g, "").toLowerCase();
        return `<span class="w" data-word="${clean}">${word}</span>`;
    }).join(' ');

    // Add CRUD: Create/Update keyword
    articleContent.querySelectorAll('.w').forEach(el => {
        el.addEventListener('click', (e) => {
            const word = (e.target as HTMLElement).getAttribute('data-word')!;
            (e.target as HTMLElement).classList.toggle('is-keyword');
            // Log to disk via RPC
            electroview.rpc.send.addKeyword({ articleId: currentArticleId, word });
            updateCurrentView();
        });
    });
}

async function updateCurrentView() {
    // Collect active keywords from UI
    const activeKeywords = Array.from(document.querySelectorAll('.is-keyword'))
        .map(el => el.getAttribute('data-word')!);
    
    if (activeKeywords.length > 0) {
        const matches = await electroview.rpc.request.getInitialMatches({ keywords: activeKeywords });
        renderFloatingNodes(matches);
    }
}

function renderFloatingNodes(matches: { id: number; score: number }[]) {
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
        el.style.transitionDelay = `${i * 0.1}s`;
        el.innerHTML = `Article #${m.id}<br><small>Relevance: ${m.score}</small>`;
        el.onclick = () => lockNode(m.id, x, y);
        nodesContainer.appendChild(el);
    });
}

async function lockNode(articleId: number, startX: number, startY: number) {
    currentArticleId = articleId;
    const keywords = await electroview.rpc.request.getKeywordsForArticle({ articleId });
    const matches = await electroview.rpc.request.lockNode({ articleId, keywords });
    
    const index = lockedNodes.length;
    const el = document.createElement('div');
    el.className = 'node locked';
    
    // Position on a dynamic path bar at the top
    const targetX = (window.innerWidth / 2) - ((lockedNodes.length + 1) * 160 / 2) + (lockedNodes.length * 160);
    const targetY = 100;
    
    el.style.left = `${startX}px`;
    el.style.top = `${startY}px`;
    
    // Animate to top
    setTimeout(() => {
        el.style.left = `${targetX}px`;
        el.style.top = `${targetY}px`;
    }, 10);

    el.innerHTML = `NODE #${articleId}`;
    el.onclick = () => unlockNode(index);
    nodesContainer.appendChild(el);
    
    lockedNodes.push({ id: articleId, el, x: targetX, y: targetY });
    
    drawAllConnections();
    renderText(`Raum #${articleId} fixiert. Keywords extrahiert. Die Schnittmenge wird berechnet...`);
    renderFloatingNodes(matches);
}

async function unlockNode(index: number) {
    const matches = await electroview.rpc.request.unlockNode({ index });
    const removed = lockedNodes.splice(index, 1)[0];
    removed.el.style.transform = 'scale(0) rotate(20deg)';
    removed.el.style.opacity = '0';
    setTimeout(() => removed.el.remove(), 500);

    // Reposition remaining nodes
    lockedNodes.forEach((node, i) => {
        const targetX = (window.innerWidth / 2) - (lockedNodes.length * 160 / 2) + (i * 160);
        node.x = targetX;
        node.el.style.left = `${targetX}px`;
    });

    drawAllConnections();
    renderFloatingNodes(matches);
}

function drawAllConnections() {
    svgConnections.innerHTML = '';
    for (let i = 1; i < lockedNodes.length; i++) {
        const p1 = lockedNodes[i-1];
        const p2 = lockedNodes[i];
        drawLine(p1.x + 75, p1.y + 86, p2.x + 75, p2.y + 86);
    }
}

function drawLine(x1: number, y1: number, x2: number, y2: number) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toString());
    line.setAttribute("y1", y1.toString());
    line.setAttribute("x2", x2.toString());
    line.setAttribute("y2", y2.toString());
    line.setAttribute("stroke", "#0f0");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-dasharray", "10,5");
    
    const animate = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    animate.setAttribute("attributeName", "stroke-dashoffset");
    animate.setAttribute("from", "100");
    animate.setAttribute("to", "0");
    animate.setAttribute("dur", "3s");
    animate.setAttribute("repeatCount", "indefinite");
    line.appendChild(animate);
    
    svgConnections.appendChild(line);
}

init();
