import { Electroview } from "electrobun/view";
import { type NerveRPCSchema } from "../types";

const rpc = Electroview.defineRPC<NerveRPCSchema>({ handlers: { requests: {}, messages: {} } });
const electroview = new Electroview({ rpc });

const nodesContainer = document.getElementById('nodes-container')!;
const breadcrumb = document.getElementById('breadcrumb')!;
const svgConnections = document.getElementById('connections')! as unknown as SVGSVGElement;
const world = document.getElementById('world')!;
const searchBtn = document.getElementById('search-btn')!;
const searchInput = document.getElementById('search-input')! as HTMLInputElement;

// Spatial Coordinates
let camX = 0;
let camY = 0;

interface NodeData {
    id: number;
    text: string;
    x: number;
    y: number;
    el: HTMLElement;
}

let lockedNodes: NodeData[] = [];
let centralNodeEl: HTMLElement | null = null;
let floatingNodes: { el: HTMLElement, id: number, x: number, y: number }[] = [];

async function init() {
    console.log("Nerve Spatial UI Initializing...");
    
    // Global Search
    searchBtn.onclick = () => performGlobalSearch(searchInput.value);
    searchInput.onkeypress = (e) => { if (e.key === 'Enter') performGlobalSearch(searchInput.value); };

    const welcomeText = "Willkommen im Nerve-Netzwerk. Nutze die Suche oben rechts oder klicke auf einen Knoten, um den Pfad zu beginnen.";
    spawnCenterNode(0, welcomeText, 0, 0);

    const initialKeywords = ["wissen", "daten", "rust"];
    const matches = await electroview.rpc.request.getInitialMatches({ keywords: initialKeywords });
    await renderFloatingNodes(matches, 0, 0);
}

function moveCamera(x: number, y: number) {
    camX = x;
    camY = y;
    world.style.transform = `translate(calc(50vw - ${camX}px), calc(50vh - ${camY}px))`;
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
        const cx = lockedNodes.length > 0 ? lockedNodes[lockedNodes.length-1].x : 0;
        const cy = lockedNodes.length > 0 ? lockedNodes[lockedNodes.length-1].y : 0;
        await renderFloatingNodes(matches, cx, cy);
    }
}

async function performGlobalSearch(query: string) {
    if (!query.trim()) return;
    const keywords = query.toLowerCase().split(/\s+/);
    
    // Unlock everything to reset path
    if (lockedNodes.length > 0) {
        await electroview.rpc.request.unlockNode({ index: 0 });
    }
    
    lockedNodes.forEach(n => n.el.remove());
    lockedNodes = [];
    renderBreadcrumb();
    svgConnections.innerHTML = '';
    
    // Spawn new center
    camX += 1000; // Jump right for new search to keep history visual context (if any)
    const newX = camX;
    const newY = camY;
    
    if (centralNodeEl) centralNodeEl.remove();
    spawnCenterNode(-1, `Globale Suche: ${keywords.join(', ')}`, newX, newY);
    
    const matches = await electroview.rpc.request.getInitialMatches({ keywords });
    await renderFloatingNodes(matches, newX, newY);
}

function spawnCenterNode(id: number, text: string, x: number, y: number) {
    centralNodeEl = document.createElement('div');
    centralNodeEl.className = 'node center';
    centralNodeEl.style.left = `${x}px`;
    centralNodeEl.style.top = `${y}px`;
    centralNodeEl.innerHTML = `
        <div class="node-header">${id === 0 ? 'NEXUS_INIT' : id === -1 ? 'SEARCH_NODE' : 'ARTIKEL #' + id}</div>
        <div class="node-body">${formatText(text)}</div>
    `;
    nodesContainer.appendChild(centralNodeEl);
    setupWordInteractions(centralNodeEl);
    moveCamera(x, y);
}

async function renderFloatingNodes(matches: { id: number; score: number }[], cx: number, cy: number) {
    floatingNodes.forEach(n => {
        n.el.style.opacity = '0';
        setTimeout(() => n.el.remove(), 800);
    });
    floatingNodes = [];
    drawAllConnections(); 

    if (matches.length === 0) {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 0 60px rgba(255, 0, 0, 0.4)"; 
        return;
    } else {
        if (centralNodeEl) centralNodeEl.style.boxShadow = "0 20px 60px rgba(0, 0, 0, 0.8), 0 0 40px rgba(74, 222, 128, 0.1)";
    }

    const textPromises = matches.map(m => electroview.rpc.request.getArticleText({ articleId: m.id }));
    const texts = await Promise.all(textPromises);

    const radiusX = 650;
    const radiusY = 500;

    matches.forEach((m, i) => {
        const angle = (i / matches.length) * Math.PI * 2 - (Math.PI / 2);
        const x = cx + Math.cos(angle) * radiusX;
        const y = cy + Math.sin(angle) * radiusY;

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
        
        el.onclick = () => transitionToCenter(m.id, content, x, y);
        
        nodesContainer.appendChild(el);
        floatingNodes.push({ el, id: m.id, x, y });
        drawLine(cx, cy, x, y, false);
    });
}

async function transitionToCenter(articleId: number, fullText: string, targetX: number, targetY: number) {
    // 1. Convert current center to history
    if (centralNodeEl) {
        const oldId = lockedNodes.length > 0 ? lockedNodes[lockedNodes.length-1].id : 0;
        centralNodeEl.classList.remove('center');
        centralNodeEl.classList.add('history');
        centralNodeEl.innerHTML = `<div class="node-header">ARTIKEL #${oldId}</div>`;
        centralNodeEl.onclick = () => unlockNode(lockedNodes.length - 1);
        
        if (lockedNodes.length === 0) {
            // First step from Nexus
            lockedNodes.push({ id: oldId, text: "", x: centralNodeEl.offsetLeft, y: centralNodeEl.offsetTop, el: centralNodeEl });
        }
    }

    // 2. Lock logic
    const keywords = await electroview.rpc.request.getKeywordsForArticle({ articleId });
    const matches = await electroview.rpc.request.lockNode({ articleId, keywords });
    
    // 3. Move camera to new node
    moveCamera(targetX, targetY);

    // 4. Transform clicked floating node
    const clickedNode = floatingNodes.find(n => n.id === articleId);
    if (clickedNode) {
        clickedNode.el.classList.remove('floating');
        clickedNode.el.classList.add('center');
        clickedNode.el.style.animation = 'none'; 
        
        setTimeout(() => {
            clickedNode.el.innerHTML = `
                <div class="node-header">ARTIKEL #${articleId}</div>
                <div class="node-body">${formatText(fullText)}</div>
            `;
            setupWordInteractions(clickedNode.el);
        }, 400);

        centralNodeEl = clickedNode.el;
        lockedNodes.push({ id: articleId, text: fullText, x: targetX, y: targetY, el: clickedNode.el });
    }

    renderBreadcrumb();
    await renderFloatingNodes(matches, targetX, targetY);
}

async function unlockNode(index: number) {
    if (index < 0 || index >= lockedNodes.length) return;
    
    const matches = await electroview.rpc.request.unlockNode({ index });
    
    // Remove nodes that are ahead of this index
    const removed = lockedNodes.splice(index + 1);
    removed.forEach(n => {
        n.el.style.opacity = '0';
        setTimeout(() => n.el.remove(), 800);
    });

    renderBreadcrumb();

    const targetNode = lockedNodes[index];
    
    if (centralNodeEl && centralNodeEl !== targetNode.el) {
        centralNodeEl.style.opacity = '0';
        setTimeout(() => centralNodeEl!.remove(), 800);
    }
    
    // Restore history node to center
    targetNode.el.classList.remove('history');
    targetNode.el.classList.add('center');
    targetNode.el.onclick = null;
    targetNode.el.innerHTML = `
        <div class="node-header">ARTIKEL #${targetNode.id}</div>
        <div class="node-body">${formatText(targetNode.text || "Nexus Core")}</div>
    `;
    setupWordInteractions(targetNode.el);
    centralNodeEl = targetNode.el;

    moveCamera(targetNode.x, targetNode.y);
    await renderFloatingNodes(matches, targetNode.x, targetNode.y);
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

function drawAllConnections() {
    svgConnections.innerHTML = '';
    // Draw solid history paths
    for (let i = 1; i < lockedNodes.length; i++) {
        drawLine(lockedNodes[i-1].x, lockedNodes[i-1].y, lockedNodes[i].x, lockedNodes[i].y, true);
    }
}

function drawLine(x1: number, y1: number, x2: number, y2: number, isHistory: boolean) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toString());
    line.setAttribute("y1", y1.toString());
    line.setAttribute("x2", x2.toString());
    line.setAttribute("y2", y2.toString());
    
    if (isHistory) {
        line.setAttribute("stroke", "rgba(74, 222, 128, 0.5)");
        line.setAttribute("stroke-width", "3");
    } else {
        line.setAttribute("stroke", "rgba(74, 222, 128, 0.15)");
        line.setAttribute("stroke-width", "1");
        line.setAttribute("stroke-dasharray", "10,5");
    }
    
    svgConnections.appendChild(line);
}

init();
