import { Electroview } from "electrobun/view";
import { type NerveRPCSchema } from "../types";

const rpc = Electroview.defineRPC<NerveRPCSchema>({ handlers: { requests: {}, messages: {} } });
const electroview = new Electroview({ rpc });

const nodesContainer = document.getElementById('nodes-container')!;
const breadcrumb = document.getElementById('breadcrumb')!;
const svgConnections = document.getElementById('connections')! as unknown as SVGSVGElement;

let lockedNodes: { id: number, text: string }[] = [];
let centralNodeEl: HTMLElement | null = null;
let floatingNodes: { el: HTMLElement, id: number }[] = [];

async function init() {
    console.log("Nerve UI V3 Initializing...");
    
    const welcomeText = "Willkommen im Nerve-Netzwerk. Wähle einen der umgebenden Artikel, um in das semantische Gewebe einzudringen. Die Schnittmenge formt deinen Pfad.";
    
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
    if (!centralNodeEl) return;
    const activeKeywords = Array.from(centralNodeEl.querySelectorAll('.is-keyword'))
        .map(el => el.getAttribute('data-word')!);
    
    if (activeKeywords.length > 0) {
        const matches = await electroview.rpc.request.getInitialMatches({ keywords: activeKeywords });
        await renderFloatingNodes(matches);
    }
}

async function renderFloatingNodes(matches: { id: number; score: number }[]) {
    // Fade out and remove old floating nodes
    floatingNodes.forEach(n => {
        n.el.style.opacity = '0';
        setTimeout(() => n.el.remove(), 800);
    });
    floatingNodes = [];
    svgConnections.innerHTML = ''; 

    if (matches.length === 0) {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 0 60px rgba(255, 0, 0, 0.4)"; 
        return;
    } else {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 20px 60px rgba(0, 0, 0, 0.8), 0 0 40px rgba(74, 222, 128, 0.1)";
    }

    const textPromises = matches.map(m => electroview.rpc.request.getArticleText({ articleId: m.id }));
    const texts = await Promise.all(textPromises);

    const radiusX = window.innerWidth * 0.4;
    const radiusY = window.innerHeight * 0.35;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    matches.forEach((m, i) => {
        // Distribute evenly around an ellipse
        const angle = (i / matches.length) * Math.PI * 2 - (Math.PI / 2);
        const x = centerX + Math.cos(angle) * radiusX;
        const y = centerY + Math.sin(angle) * radiusY;

        const el = document.createElement('div');
        el.className = 'node floating';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.animationDelay = `-${i * 1.5}s`; 
        
        const content = texts[i] || "Kein Inhalt verfügbar.";
        const bodyText = content.length > 250 ? content.substring(0, 250) + "..." : content;

        el.innerHTML = `
            <div class="node-header">ARTIKEL #${m.id} &middot; REL: ${m.score}</div>
            <div class="node-body">${bodyText}</div>
        `;
        
        el.onclick = () => transitionToCenter(m.id, content);
        
        nodesContainer.appendChild(el);
        floatingNodes.push({ el, id: m.id });
        drawLine(centerX, centerY, x, y);
    });
}

async function transitionToCenter(articleId: number, fullText: string) {
    const keywords = await electroview.rpc.request.getKeywordsForArticle({ articleId });
    const matches = await electroview.rpc.request.lockNode({ articleId, keywords });
    
    lockedNodes.push({ id: articleId, text: fullText });
    renderBreadcrumb();

    if (centralNodeEl) {
        // Instead of removing, we smoothly update the content of the central node
        centralNodeEl.style.opacity = '0';
        centralNodeEl.style.transform = 'translate(-50%, -50%) scale(0.95)';
        
        setTimeout(() => {
            centralNodeEl!.innerHTML = `
                <div class="node-header">ARTIKEL #${articleId}</div>
                <div class="node-body">${formatText(fullText)}</div>
            `;
            setupWordInteractions(centralNodeEl!);
            centralNodeEl!.style.opacity = '1';
            centralNodeEl!.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 400);
    }

    await renderFloatingNodes(matches);
}

async function unlockNode(index: number) {
    const matches = await electroview.rpc.request.unlockNode({ index });
    lockedNodes.splice(index, lockedNodes.length - index); // Remove this and all subsequent nodes
    renderBreadcrumb();

    if (centralNodeEl) {
        centralNodeEl.style.opacity = '0';
        centralNodeEl.style.transform = 'translate(-50%, -50%) scale(0.95)';
        
        setTimeout(() => {
            if (lockedNodes.length > 0) {
                const last = lockedNodes[lockedNodes.length - 1];
                centralNodeEl!.innerHTML = `
                    <div class="node-header">ARTIKEL #${last.id}</div>
                    <div class="node-body">${formatText(last.text)}</div>
                `;
            } else {
                centralNodeEl!.innerHTML = `
                    <div class="node-header">NEXUS_INIT</div>
                    <div class="node-body">${formatText("Zurück im Nexus. Pfad zurückgesetzt.")}</div>
                `;
            }
            setupWordInteractions(centralNodeEl!);
            centralNodeEl!.style.opacity = '1';
            centralNodeEl!.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 400);
    }

    await renderFloatingNodes(matches);
}

function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    lockedNodes.forEach((n, i) => {
        const btn = document.createElement('div');
        btn.className = 'breadcrumb-item';
        btn.innerText = `ARTIKEL #${n.id}`;
        btn.title = "Klicken, um zu diesem Knoten zurückzukehren";
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
    line.setAttribute("stroke", "rgba(74, 222, 128, 0.15)");
    line.setAttribute("stroke-width", "1");
    svgConnections.appendChild(line);
}

init();
