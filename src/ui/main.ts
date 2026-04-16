import { Electroview } from "electrobun/view";
import { type NerveRPCSchema } from "../types";

const rpc = Electroview.defineRPC<NerveRPCSchema>({ handlers: { requests: {}, messages: {} } });
const electroview = new Electroview({ rpc });

const nodesContainer = document.getElementById('nodes-container')!;
const breadcrumb = document.getElementById('breadcrumb')!;
const svgConnections = document.getElementById('connections')! as unknown as SVGSVGElement;

const SQRT3 = Math.sqrt(3);
const hexOffsets = [
    { x: 1, y: 0 }, { x: 0.5, y: SQRT3/2 }, { x: -0.5, y: SQRT3/2 },
    { x: -1, y: 0 }, { x: -0.5, y: -SQRT3/2 }, { x: 0.5, y: -SQRT3/2 }
];

let lockedNodes: { id: number, text: string }[] = [];
let centralNodeEl: HTMLElement | null = null;

async function init() {
    console.log("Nerve UI V2 Initializing...");
    
    const welcomeText = "Willkommen im Nerve-Netzwerk. Wähle einen der schwebenden Artikel, um in das semantische Gewebe einzudringen. Die Schnittmenge formt deinen Pfad.";
    
    centralNodeEl = document.createElement('div');
    centralNodeEl.className = 'node center';
    centralNodeEl.innerHTML = `
        <div class="node-header">NEXUS_INIT</div>
        <div class="node-body">${formatText(welcomeText)}</div>
    `;
    nodesContainer.appendChild(centralNodeEl);
    setupWordInteractions(centralNodeEl);

    const initialKeywords = ["wissen", "daten", "rust", "word_1_5"];
    const matches = await electroview.rpc.request.getInitialMatches({ keywords: initialKeywords });
    await renderFloatingNodes(matches);
}

function formatText(text: string) {
    return text.split(/\s+/).map(word => {
        const clean = word.replace(/[^a-zA-Zäöüß]/g, "").toLowerCase();
        return `<span class="w" data-word="${clean}">${word}</span>`;
    }).join(' ');
}

function setupWordInteractions(container: HTMLElement) {
    container.querySelectorAll('.w').forEach(el => {
        el.addEventListener('click', (e) => {
            const word = (e.target as HTMLElement).getAttribute('data-word')!;
            (e.target as HTMLElement).classList.toggle('is-keyword');
            const articleId = lockedNodes.length > 0 ? lockedNodes[lockedNodes.length - 1].id : 0;
            electroview.rpc.send.addKeyword({ articleId, word });
            updateCurrentView();
        });
    });
}

async function updateCurrentView() {
    const activeKeywords = Array.from(centralNodeEl!.querySelectorAll('.is-keyword'))
        .map(el => el.getAttribute('data-word')!);
    
    if (activeKeywords.length > 0) {
        const matches = await electroview.rpc.request.getInitialMatches({ keywords: activeKeywords });
        await renderFloatingNodes(matches);
    }
}

async function renderFloatingNodes(matches: { id: number; score: number }[]) {
    document.querySelectorAll('.floating').forEach(el => el.remove());

    if (matches.length === 0) {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 0 50px rgba(255, 0, 0, 0.6)"; 
        svgConnections.innerHTML = '';
        return;
    } else {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 0 50px rgba(0, 255, 0, 0.2)";
    }

    const textPromises = matches.map(m => electroview.rpc.request.getArticleText({ articleId: m.id }));
    const texts = await Promise.all(textPromises);

    svgConnections.innerHTML = ''; 

    matches.forEach((m, i) => {
        const offset = hexOffsets[i % 6];
        const dist = 480; 
        const x = window.innerWidth / 2 + offset.x * dist;
        const y = window.innerHeight / 2 + offset.y * dist;

        const el = document.createElement('div');
        el.className = 'node floating';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.animationDelay = `-${i}s`; 
        
        const content = texts[i] || "Kein Inhalt verfügbar.";
        const bodyText = content.length > 300 ? content.substring(0, 300) + "..." : content;

        el.innerHTML = `
            <div class="node-header">ARTIKEL #${m.id} | REL: ${m.score}</div>
            <div class="node-body">${bodyText}</div>
        `;
        
        el.onclick = () => transitionToCenter(el, m.id, content);
        
        nodesContainer.appendChild(el);
        drawLine(window.innerWidth / 2, window.innerHeight / 2, x, y);
    });
}

async function transitionToCenter(floatingEl: HTMLElement, articleId: number, fullText: string) {
    const keywords = await electroview.rpc.request.getKeywordsForArticle({ articleId });
    const matches = await electroview.rpc.request.lockNode({ articleId, keywords });
    
    lockedNodes.push({ id: articleId, text: fullText });
    renderBreadcrumb();

    if (centralNodeEl) {
        centralNodeEl.style.opacity = '0';
        centralNodeEl.style.transform = 'translate(-50%, -50%) scale(0.5)';
        setTimeout(() => centralNodeEl!.remove(), 800);
    }

    floatingEl.classList.remove('floating');
    floatingEl.classList.add('center');
    floatingEl.style.left = '50%';
    floatingEl.style.top = '50%';
    floatingEl.style.animation = 'none'; 
    
    floatingEl.innerHTML = `
        <div class="node-header">ARTIKEL #${articleId}</div>
        <div class="node-body">${formatText(fullText)}</div>
    `;
    setupWordInteractions(floatingEl);
    
    centralNodeEl = floatingEl;

    await renderFloatingNodes(matches);
}

async function unlockNode(index: number) {
    const matches = await electroview.rpc.request.unlockNode({ index });
    lockedNodes.splice(index, 1);
    renderBreadcrumb();

    if (centralNodeEl) centralNodeEl.remove();
    
    centralNodeEl = document.createElement('div');
    centralNodeEl.className = 'node center';
    
    if (lockedNodes.length > 0) {
        const last = lockedNodes[lockedNodes.length - 1];
        centralNodeEl.innerHTML = `
            <div class="node-header">ARTIKEL #${last.id}</div>
            <div class="node-body">${formatText(last.text)}</div>
        `;
    } else {
        centralNodeEl.innerHTML = `
            <div class="node-header">NEXUS_INIT</div>
            <div class="node-body">${formatText("Zurück im Nexus. Pfad zurückgesetzt.")}</div>
        `;
    }
    
    nodesContainer.appendChild(centralNodeEl);
    setupWordInteractions(centralNodeEl);

    await renderFloatingNodes(matches);
}

function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    lockedNodes.forEach((n, i) => {
        const btn = document.createElement('div');
        btn.className = 'breadcrumb-item';
        btn.innerText = `[${i}] ARTIKEL #${n.id}`;
        btn.title = "Klicken, um diesen Knoten aus dem Pfad zu entfernen";
        btn.onclick = () => unlockNode(i);
        breadcrumb.appendChild(btn);
    });
}

function drawLine(x1: number, y1: number, x2: number, y2: number) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toString());
    line.setAttribute("y1", y1.toString());
    line.setAttribute("x2", x2.toString());
    line.setAttribute("y2", y2.toString());
    line.setAttribute("stroke", "rgba(0, 255, 0, 0.2)");
    line.setAttribute("stroke-width", "2");
    
    svgConnections.appendChild(line);
}

init();
