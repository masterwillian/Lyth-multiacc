// renderer.js — processo renderer sandboxed, sem acesso direto ao Node.js.
const api = window.lyth;
const mc = {
    getWorkspace: api.workspace.get,
    createGroup: api.workspace.createGroup,
    updateGroup: api.workspace.updateGroup,
    deleteGroup: api.workspace.deleteGroup,
    renameAccount: api.profiles.rename,
    addAccount: api.profiles.add,
    removeAccount: api.profiles.remove,
    onGroupCreated: api.workspace.onGroupCreated,
    onAccountAdded: api.profiles.onAdded,
    onAccountRemoved: api.profiles.onRemoved,
    newIdentity: api.tor.newIdentity,
    getCircuitInfo: api.tor.getCircuitInfo,
    onBootstrapProgress: api.tor.onBootstrapProgress,
    onBootComplete: api.tor.onBootComplete,
    onBootError: api.tor.onBootError,
    checkLeaks: api.health.checkRoute,
    getAccountHealth: api.health.get,
    onAccountHealth: api.health.onUpdate,
    importLegacyRendererData: api.storage.importLegacyRendererData
};
const grid    = document.getElementById("grid");
const splash  = document.getElementById("splash");
const overviewOrderKey = "multiclient-overview-order";
const groupColors = [
    "#7c6fff", "#3ddc84", "#ffb84d", "#ff6b6b", "#5ad0ff",
    "#d77dff", "#7be0c3", "#ff9bd2", "#f9d65c", "#74c69d",
    "#ff7f50", "#70e000", "#00b4d8", "#f72585", "#ff9f1c",
    "#9b5de5", "#00bbf9", "#80ed99", "#ffb703", "#fb8500"
];

function safeStoredArray(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(value) ? value : [];
    } catch { return []; }
}

function safeStoredUrl(value) {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

function collectLegacyRendererData() {
    const profiles = {};
    const ensure = id => profiles[id] ||= { bookmarks: [], urlHistory: [], ipHistory: [], lastUrl: null };
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        const match = /^(account-url|bookmarks|url-history|ip-history)-(\d+)$/.exec(key || "");
        if (!match) continue;
        const profileId = Number(match[2]);
        if (!Number.isSafeInteger(profileId) || profileId < 1) continue;
        const data = ensure(profileId);
        if (match[1] === "account-url") data.lastUrl = safeStoredUrl(localStorage.getItem(key));
        if (match[1] === "url-history") data.urlHistory = safeStoredArray(key).map(safeStoredUrl).filter(Boolean);
        if (match[1] === "ip-history") data.ipHistory = safeStoredArray(key).filter(value => typeof value === "string");
        if (match[1] === "bookmarks") data.bookmarks = safeStoredArray(key).map(item => ({
            url: safeStoredUrl(item?.url),
            title: String(item?.title || item?.url || "").slice(0, 300),
            date: item?.date
        })).filter(item => item.url && item.title);
    }
    return {
        overviewOrder: safeStoredArray(overviewOrderKey).map(Number).filter(Number.isSafeInteger),
        profiles
    };
}

function clearMigratedLocalStorage(payload) {
    localStorage.removeItem(overviewOrderKey);
    for (const id of Object.keys(payload.profiles)) {
        for (const prefix of ["account-url", "bookmarks", "url-history", "ip-history", "account-name"]) {
            localStorage.removeItem(`${prefix}-${id}`);
        }
    }
}

const legacyRendererData = collectLegacyRendererData();
mc.importLegacyRendererData(legacyRendererData)
    .then(() => clearMigratedLocalStorage(legacyRendererData))
    .catch(error => console.error("Falha ao migrar dados locais para SQLite:", error))
    .then(() => mc.getWorkspace())
    .then(({ accounts: initialAccounts, groups, uiState = {} }) => {
let accounts = initialAccounts;
const profileUiData = uiState.profiles || {};
let overviewOrder = Array.isArray(uiState.overviewOrder) ? uiState.overviewOrder : [];

function profileData(accountId) {
    return profileUiData[accountId] ||= { lastUrl: null, bookmarks: [], urlHistory: [], ipHistory: [] };
}

function persist(promise) {
    promise.catch(error => console.error("Falha ao persistir dados do perfil:", error));
}

function escapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getGroupColor(groupId) {
    const index = Number(groupId || 0);
    return groupColors[(index - 1 + groupColors.length) % groupColors.length] || groupColors[0];
}

function renderGroupButtonMeta(group) {
    const tagHtml = group.tag ? `<span class="group-tag" title="Tag: ${escapeHtml(group.tag)}">${escapeHtml(group.tag)}</span>` : "";
    if (!tagHtml) return "";
    return `<div class="group-btn-meta">${tagHtml}</div>`;
}

function syncOverviewOrder() {
    const validIds = accounts.map(account => account.id);
    const merged = [...new Set([...(overviewOrder || []).filter(id => validIds.includes(Number(id))), ...validIds])];
    if (JSON.stringify(merged) !== JSON.stringify(overviewOrder)) {
        overviewOrder = merged;
        persist(api.storage.setOverviewOrder(merged));
    }
    return merged;
}

function getOrderedAccountIds() {
    const order = syncOverviewOrder();
    return order.filter(id => accounts.some(account => account.id === Number(id)));
}

function updateOverviewGridLayout() {
    if (grid.classList.contains("layout-focus")) return;
    // The workspace stays modular through additional rows, while keeping three
    // readable account panels per row.
    grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    grid.style.gridAutoRows = "minmax(220px, 1fr)";
}

function reorderOverview(sourceId, targetId) {
    if (grid.dataset.view !== "overview") return;
    const order = getOrderedAccountIds();
    const sourceIndex = order.indexOf(Number(sourceId));
    const targetIndex = order.indexOf(Number(targetId));
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;

    order.splice(sourceIndex, 1);
    order.splice(targetIndex, 0, Number(sourceId));
    overviewOrder = order;
    persist(api.storage.setOverviewOrder(order));

    const sourceCell = document.querySelector(`.cell[data-account-id="${sourceId}"]`);
    const targetCell = document.querySelector(`.cell[data-account-id="${targetId}"]`);
    if (!sourceCell || !targetCell || !sourceCell.parentNode) return;

    const ref = targetCell.nextSibling;
    sourceCell.parentNode.insertBefore(sourceCell, ref);
}

let appBootCompleted = false;
let routeRefreshTimer = null;

function reloadAllAccounts() {
    if (!appBootCompleted) return;

    const webviewEntries = Object.entries(webviews);
    if (!webviewEntries.length) return;

    webviewEntries.forEach(([accountId, wv]) => {
        if (wv && typeof wv.reload === "function" && !wv.isLoading()) {
            try {
                wv.reload();
            } catch (_) {}
        }
    });
}

function applyGroupAccent(element, groupId) {
    const color = getGroupColor(groupId);
    element.style.setProperty("--group-accent", color);
    return color;
}

function setupCellDragAndDrop(cell, accountId) {
    cell.draggable = true;
    cell.addEventListener("dragstart", (event) => {
        if (grid.dataset.view !== "overview") return;
        cell.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(accountId));
    });

    cell.addEventListener("dragend", () => {
        cell.classList.remove("dragging");
        document.querySelectorAll(".cell").forEach(item => item.classList.remove("drag-over"));
    });

    cell.addEventListener("dragover", (event) => {
        if (grid.dataset.view !== "overview") return;
        event.preventDefault();
        cell.classList.add("drag-over");
    });

    cell.addEventListener("dragleave", () => {
        cell.classList.remove("drag-over");
    });

    cell.addEventListener("drop", (event) => {
        if (grid.dataset.view !== "overview") return;
        event.preventDefault();
        const sourceId = Number(event.dataTransfer.getData("text/plain")) || Number(cell.dataset.accountId);
        const targetId = Number(cell.dataset.accountId);
        if (!sourceId || !targetId || sourceId === targetId) return;
        reorderOverview(sourceId, targetId);
        cell.classList.remove("drag-over");
    });
}

// ══════════════════════════════════════════════════
// SPLASH SCREEN — barras de progresso por instância
// ══════════════════════════════════════════════════

const splashContainer = document.getElementById("splash-instances");
const splashStatus    = document.getElementById("splash-status");

// Rastreia progresso de cada instância
const bootProgress = {};
accounts.forEach(acc => {
    bootProgress[acc.id] = 0;

    const row = document.createElement("div");
    row.className = "splash-row";
    row.innerHTML = `
        <span class="splash-row-label">Tor ${acc.torPort}</span>
        <div class="splash-bar-wrap">
            <div class="splash-bar-fill" id="bar-${acc.id}"></div>
        </div>
        <span class="splash-pct" id="pct-${acc.id}">0%</span>
    `;
    splashContainer.appendChild(row);
});

// Recebe eventos de progresso do main
mc.onBootstrapProgress(({ id, pct }) => {
    bootProgress[id] = pct;

    const bar = document.getElementById(`bar-${id}`);
    const pctEl = document.getElementById(`pct-${id}`);
    if (bar) {
        bar.style.width = pct + "%";
        if (pct === 100) bar.classList.add("done");
    }
    if (pctEl) pctEl.textContent = pct + "%";

    const done = Object.values(bootProgress).filter(p => p === 100).length;
    splashStatus.textContent = `${done} de ${accounts.length} instâncias prontas…`;
});

// Boot completo — fade-out da splash E carrega URLs nas webviews
mc.onBootComplete(() => {
    appBootCompleted = true;
    splashStatus.textContent = "✅ Inicialização concluída. Carregando…";
    
    // Carrega URLs nas webviews agora que o proxy está pronto
    Object.keys(webviews).forEach(accountId => {
        const wv = webviews[accountId];
        const initialUrl = wv.dataset.initialUrl;
        if (wv && initialUrl) {
            wv.src = initialUrl;
        }
    });
    accounts.forEach(account => refreshAccountIP(account));
    // A rota pública da conta é checada em um intervalo fixo, sem depender do
    // site atualmente aberto dentro da webview.
    if (routeRefreshTimer) clearInterval(routeRefreshTimer);
    routeRefreshTimer = setInterval(() => {
        accounts.forEach(account => refreshAccountIP(account));
    }, 60_000);
    
    setTimeout(() => {
        splash.classList.add("hidden");
    }, 600);
});

// Erro de boot
mc.onBootError((msg) => {
    splashStatus.textContent = `❌ Erro: ${msg}`;
    splashStatus.style.color = "#ff5555";
});

// ══════════════════════════════════════════════════
// KEYBOARD SHORTCUTS HELP
// ══════════════════════════════════════════════════
console.log(`
🎮 Keyboard Shortcuts:
  Ctrl+L  — Focar URL bar
  Ctrl+R  — Recarregar página
  Ctrl+W  — Remover conta
  Ctrl+K  — Forçar novo circuito Tor
  Ctrl+D  — Abrir DevTools
`);

// ══════════════════════════════════════════════════
// LAYOUT TOGGLE
// ══════════════════════════════════════════════════

let focusedAccountId = null;

function exitFocus() {
    grid.classList.remove("layout-focus");
    document.querySelectorAll(".cell").forEach(cell => cell.classList.remove("focused"));
    focusedAccountId = null;
    updateOverviewGridLayout();
    applyVisibleAccounts();
}

function focusCell(accountId) {
    focusedAccountId = accountId;
    grid.classList.add("layout-focus");

    document.querySelectorAll(".cell").forEach(c => {
        c.classList.remove("focused");
        if (parseInt(c.dataset.accountId) === accountId) {
            c.classList.add("focused");
        }
    });
    applyVisibleAccounts();
}

function applyVisibleAccounts() {
    const showAll = grid.dataset.view === "overview";
    const focusMode = grid.classList.contains("layout-focus");
    document.querySelectorAll(".cell").forEach(cell => {
        const inGroup = Number(cell.dataset.groupId) === activeGroupId;
        const isFocused = Number(cell.dataset.accountId) === focusedAccountId;
        const shouldHide = focusMode ? !isFocused : (!showAll && !inGroup);
        cell.classList.toggle("group-hidden", shouldHide);
    });
}

// ══════════════════════════════════════════════════
// CONSTRUÇÃO DOS PAINÉIS
// ══════════════════════════════════════════════════

// Referências globais por conta (para New Identity e DevTools)
const webviews = {};
const ipBadges = {};
const routeChecksInFlight = new Set();
const lastRouteCheckAt = new Map();
const accountCleanups = new Map();

function cleanupAccountPanel(accountId) {
    const cleanup = accountCleanups.get(Number(accountId));
    if (cleanup) cleanup();
    accountCleanups.delete(Number(accountId));
    delete webviews[accountId];
    delete ipBadges[accountId];
    routeChecksInFlight.delete(Number(accountId));
    lastRouteCheckAt.delete(Number(accountId));
}

window.addEventListener("beforeunload", () => {
    if (routeRefreshTimer) clearInterval(routeRefreshTimer);
    for (const cleanup of accountCleanups.values()) cleanup();
    accountCleanups.clear();
});

function showIPBadge(account, ip, message) {
    const ipBadge = ipBadges[account.id];
    if (!ipBadge) return;
    ipBadge.className = "ip-badge ready";
    ipBadge.textContent = ip;
    ipBadge.title = message;
    saveIp(account.id, ip);
}

async function refreshAccountIP(account, force = false) {
    const ipBadge = ipBadges[account.id];
    if (!ipBadge) return;
    if (routeChecksInFlight.has(account.id)) return;
    const lastCheck = lastRouteCheckAt.get(account.id) || 0;
    if (!force && Date.now() - lastCheck < 15000) return;
    routeChecksInFlight.add(account.id);
    ipBadge.className = "ip-badge loading";
    ipBadge.textContent = "Verificando IP…";
    try {
        const route = await mc.checkLeaks({ accountId: account.id, force });
        if (route.hasLeak) {
            ipBadge.className = "ip-badge error";
            ipBadge.textContent = "⚠ rota fora do Tor";
            ipBadge.title = route.message;
            return;
        }
        showIPBadge(account, route.ip, `${route.message} · clique para atualizar`);
    } catch (error) {
        ipBadge.className = "ip-badge error";
        ipBadge.textContent = "IP não verificado";
        ipBadge.title = error.message || "Falha ao validar a rota Chromium";
    } finally {
        lastRouteCheckAt.set(account.id, Date.now());
        routeChecksInFlight.delete(account.id);
    }
}

function updateAccountStatus(accountId, statusState) {
    const indicator = document.querySelector(`.account-status[data-account-id="${accountId}"]`);
    const label = document.querySelector(`.account-status-label[data-account-id="${accountId}"]`);
    if (indicator) {
        indicator.className = `account-status status-${statusState.status || "unknown"}`;
        indicator.title = statusState.message || "Sem status";
    }
    if (label) {
        label.textContent = statusState.message || "Sem status";
    }
}

function createAccountPanel(account) {

    // ── Célula ──
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.accountId = account.id;
    cell.dataset.groupId = account.batchId;
    applyGroupAccent(cell, account.batchId);
    setupCellDragAndDrop(cell, account.id);

    // ── Barra do painel ──
    const bar = document.createElement("div");
    bar.className = "cell-bar";

    const statusWrap = document.createElement("div");
    statusWrap.className = "account-status-wrap";

    const statusIndicator = document.createElement("span");
    statusIndicator.className = "account-status status-starting";
    statusIndicator.dataset.accountId = String(account.id);
    statusIndicator.title = "Iniciando...";

    const statusLabel = document.createElement("span");
    statusLabel.className = "account-status-label";
    statusLabel.dataset.accountId = String(account.id);
    statusLabel.textContent = "Aguardando...";

    statusWrap.append(statusIndicator, statusLabel);

    // — Label editável —
    const label = document.createElement("span");
    label.className = "cell-label";
    label.textContent = account.name;
    label.title = "Duplo clique para renomear";

    label.addEventListener("dblclick", () => {
        const input = document.createElement("input");
        input.className = "cell-label-input";
        input.value = label.textContent;
        input.style.width = Math.max(60, label.offsetWidth + 10) + "px";

        bar.replaceChild(input, label);
        input.focus();
        input.select();

        const finishRename = () => {
            const newName = input.value.trim() || account.name;
            label.textContent = newName;
            account.name = newName;
            mc.renameAccount({ accountId: account.id, name: newName }).catch(error => {
                console.error("Não foi possível salvar o nome da conta:", error);
            });
            bar.replaceChild(label, input);
        };

        input.addEventListener("blur", finishRename);
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") finishRename();
            if (e.key === "Escape") {
                bar.replaceChild(label, input);
            }
        });
    });

    // — Botões de navegação —
    const navBtns = document.createElement("div");
    navBtns.className = "nav-btns";

    const backBtn  = makeNavBtn("←", "Voltar");
    const fwdBtn   = makeNavBtn("→", "Avançar");
    const reloadBtn = makeNavBtn("↺", "Recarregar");
    const stopBtn  = makeNavBtn("✕", "Parar");

    stopBtn.style.display = "none";

    navBtns.append(backBtn, fwdBtn, reloadBtn, stopBtn);

    // — URL input + datalist para histórico —
    const urlWrap = document.createElement("div");
    urlWrap.className = "cell-url-wrap";

    const listId = `history-${account.id}`;
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    document.body.appendChild(datalist);

    const urlInput = document.createElement("input");
    urlInput.className = "cell-url";
    urlInput.type = "text";
    urlInput.value = profileData(account.id).lastUrl || "https://checkip.amazonaws.com/";
    urlInput.placeholder = "https://...";
    urlInput.setAttribute("list", listId);

    // Carrega histórico salvo
    loadHistory(account.id, datalist);

    urlWrap.appendChild(urlInput);

    // — IP Badge —
    const ipBadge = document.createElement("span");
    ipBadge.className = "ip-badge loading";
    ipBadge.textContent = `Tor :${account.torPort}`;
    ipBadges[account.id] = ipBadge;
    ipBadge.addEventListener("click", () => refreshAccountIP(account, true));

    const ipHistoryBtn = document.createElement("button");
    ipHistoryBtn.className = "action-btn";
    ipHistoryBtn.innerHTML = "⌁";
    ipHistoryBtn.dataset.tip = "IPs usados";
    ipHistoryBtn.title = "IPs usados nesta conta";
    ipHistoryBtn.addEventListener("click", () => showIpHistory(account, label.textContent));

    // — Botões de ação —
    const actionBtns = document.createElement("div");
    actionBtns.className = "action-btns";

    // New Identity
    const newIdBtn = document.createElement("button");
    newIdBtn.className = "action-btn";
    newIdBtn.innerHTML = "⟳";
    newIdBtn.dataset.tip = "New Identity";
    newIdBtn.title = "New Identity";

    newIdBtn.addEventListener("click", async () => {
        if (newIdBtn.disabled) return;
        newIdBtn.disabled = true;
        newIdBtn.classList.add("spinning");
        ipBadge.className = "ip-badge spinning";
        ipBadge.textContent = "Trocando IP…";

        try {
            const result = await mc.newIdentity(account.id);
            ipBadge.className = result.routeVerified ? "ip-badge ready" : "ip-badge error";
            ipBadge.textContent = result.currentIP || (result.signalSucceeded ? "IP não verificado" : "Falha no ControlPort");
            ipBadge.title = result.message;
            if (result.currentIP) saveIp(account.id, result.currentIP);
            const wv = webviews[account.id];
            if (wv && result.signalSucceeded) wv.reloadIgnoringCache();
        } catch (e) {
            ipBadge.className = "ip-badge error";
            ipBadge.textContent = "⚠ ControlPort";
            console.error("New Identity error:", e);
        } finally {
            newIdBtn.disabled = false;
            newIdBtn.classList.remove("spinning");
        }
    });

    // DevTools
    const devBtn = document.createElement("button");
    devBtn.className = "action-btn";
    devBtn.innerHTML = "🛠";
    devBtn.dataset.tip = "DevTools";
    devBtn.title = "Abrir DevTools";

    devBtn.addEventListener("click", () => {
        const wv = webviews[account.id];
        if (wv) wv.openDevTools();
    });

    // Focus
    const focusBtn = document.createElement("button");
    focusBtn.className = "action-btn";
    focusBtn.innerHTML = "⤢";
    focusBtn.dataset.tip = "Foco";
    focusBtn.title = "Foco neste painel";

    focusBtn.addEventListener("click", () => {
        if (grid.classList.contains("layout-focus") && focusedAccountId === account.id) {
            exitFocus();
        } else {
            focusCell(account.id);
        }
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "action-btn remove-account-btn";
    removeBtn.innerHTML = "×";
    removeBtn.dataset.tip = "Remover conta";
    removeBtn.title = "Remover conta do lote";
    removeBtn.addEventListener("click", async () => {
        if (!window.confirm(`Remover ${label.textContent} deste lote? Os dados do perfil serão preservados.`)) return;
        removeBtn.disabled = true;
        try {
            await mc.removeAccount(account.id);
        } catch (error) {
            removeBtn.disabled = false;
            window.alert(error.message || "Não foi possível remover a conta.");
        }
    });

    actionBtns.append(newIdBtn, ipHistoryBtn, devBtn, focusBtn, removeBtn);

    // — Monta barra —
    bar.append(label, navBtns, urlWrap, ipBadge, actionBtns);

    // ── Progress bar de carregamento de página ──
    const pageProgress = document.createElement("div");
    pageProgress.className = "page-progress";
    cell.style.position = "relative";

    // ── Webview com partition isolada (sem carregar URL de imediato) ──
    const wv = document.createElement("webview");
    wv.setAttribute("partition", account.partition);
    wv.setAttribute("src", "about:blank");
    webviews[account.id] = wv;
    wv.dataset.initialUrl = urlInput.value;

    // — Navegação —
    function navigate() {
        let url = urlInput.value.trim();
        if (!url) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
            urlInput.value = url;
        }
        profileData(account.id).lastUrl = url;
        persist(api.storage.setLastUrl({ profileId: account.id, url }));
        wv.src = url;
    }

    backBtn.addEventListener("click",   () => wv.goBack());
    fwdBtn.addEventListener("click",    () => wv.goForward());
    reloadBtn.addEventListener("click", () => wv.reload());
    stopBtn.addEventListener("click",   () => wv.stop());

    urlInput.addEventListener("keydown", e => {
        if (e.key === "Enter") navigate();
    });

    // — Atualiza URL bar ao navegar —
    wv.addEventListener("did-navigate", e => {
        urlInput.value = e.url;
        if (e.url !== "about:blank") {
            profileData(account.id).lastUrl = e.url;
            persist(api.storage.setLastUrl({ profileId: account.id, url: e.url }));
        }
        pushHistory(account.id, e.url, datalist);
    });

    wv.addEventListener("did-navigate-in-page", e => {
        if (e.isMainFrame) {
            urlInput.value = e.url;
            if (e.url !== "about:blank") {
                profileData(account.id).lastUrl = e.url;
                persist(api.storage.setLastUrl({ profileId: account.id, url: e.url }));
            }
            pushHistory(account.id, e.url, datalist);
        }
    });

    // — Estado de carregamento —
    wv.addEventListener("did-start-loading", () => {
        pageProgress.classList.add("active");
        pageProgress.style.width = "0%";
        reloadBtn.style.display = "none";
        stopBtn.style.display = "flex";
    });

    wv.addEventListener("did-stop-loading", () => {
        pageProgress.classList.remove("active");
        pageProgress.style.width = "100%";
        setTimeout(() => { pageProgress.style.width = "0%"; }, 300);
        reloadBtn.style.display = "flex";
        stopBtn.style.display = "none";

        // Atualiza estado back/fwd
        backBtn.disabled  = !wv.canGoBack();
        fwdBtn.disabled   = !wv.canGoForward();
    });

    wv.addEventListener("did-fail-load", (e) => {
        if (e.errorCode === -3 || e.isMainFrame === false) return;
        reloadBtn.style.display = "flex";
        stopBtn.style.display = "none";
    });

    // — Botão Favoritar (Bookmarks) ──
    const bookmarkBtn = document.createElement("button");
    bookmarkBtn.className = "action-btn";
    bookmarkBtn.title = "Adicionar aos favoritos";
    bookmarkBtn.innerHTML = "★";
    bookmarkBtn.style.fontSize = "18px";
    bookmarkBtn.style.color = "#888";

    const bookmarks = profileData(account.id).bookmarks;

    function updateBookmarkBtn() {
        const currentUrl = urlInput.value.trim();
        const isBookmarked = bookmarks.some(b => b.url === currentUrl);
        bookmarkBtn.style.color = isBookmarked ? "#ffd700" : "#888";
        bookmarkBtn.textContent = isBookmarked ? "★" : "☆";
    }

    bookmarkBtn.addEventListener("click", () => {
        const currentUrl = urlInput.value.trim();
        if (!currentUrl) return;

        const index = bookmarks.findIndex(b => b.url === currentUrl);
        if (index > -1) {
            bookmarks.splice(index, 1);
        } else {
            const title = urlInput.value.split('/')[2] || currentUrl;
            bookmarks.push({ url: currentUrl, title, date: new Date().toISOString() });
        }

        persist(api.storage.replaceBookmarks({ profileId: account.id, bookmarks }));
        updateBookmarkBtn();
    });

    urlInput.addEventListener("change", updateBookmarkBtn);
    updateBookmarkBtn();

    // ── Menu de Bookmarks ──
    const bookmarkMenu = document.createElement("div");
    bookmarkMenu.className = "bookmark-menu";
    bookmarkMenu.style.display = "none";
    bookmarkMenu.style.position = "absolute";
    bookmarkMenu.style.top = "100%";
    bookmarkMenu.style.right = "0";
    bookmarkMenu.style.background = "#222";
    bookmarkMenu.style.border = "1px solid #444";
    bookmarkMenu.style.borderRadius = "4px";
    bookmarkMenu.style.maxHeight = "300px";
    bookmarkMenu.style.overflowY = "auto";
    bookmarkMenu.style.zIndex = "1000";
    bookmarkMenu.style.minWidth = "250px";
    bookmarkMenu.style.position = "absolute";

    function updateBookmarkMenu() {
        bookmarkMenu.replaceChildren();
        if (!bookmarks.length) {
            const empty = document.createElement("div");
            empty.style.padding = "8px";
            empty.style.color = "#888";
            empty.textContent = "Nenhum favorito";
            bookmarkMenu.appendChild(empty);
            return;
        }
        bookmarks.forEach((bookmark, index) => {
            const row = document.createElement("div");
            row.className = "bookmark-menu-row";
            const link = document.createElement("button");
            link.type = "button";
            link.className = "bookmark-menu-link";
            link.textContent = bookmark.url;
            link.addEventListener("click", () => {
                urlInput.value = bookmark.url;
                navigate();
                bookmarkMenu.style.display = "none";
            });
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "bookmark-menu-remove";
            remove.textContent = "✕";
            remove.addEventListener("click", event => {
                event.stopPropagation();
                bookmarks.splice(index, 1);
                persist(api.storage.replaceBookmarks({ profileId: account.id, bookmarks }));
                updateBookmarkMenu();
                updateBookmarkBtn();
            });
            row.append(link, remove);
            bookmarkMenu.appendChild(row);
        });
    }

    const bookmarkContainer = document.createElement("div");
    bookmarkContainer.style.position = "relative";
    bookmarkContainer.style.display = "inline-block";
    bookmarkContainer.appendChild(bookmarkBtn);
    bookmarkContainer.appendChild(bookmarkMenu);

    bookmarkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bookmarkMenu.style.display = bookmarkMenu.style.display === "none" ? "block" : "none";
        if (bookmarkMenu.style.display === "block") {
            updateBookmarkMenu();
        }
    });

    actionBtns.prepend(bookmarkContainer);

    // — Monta célula —
    cell.appendChild(pageProgress);
    cell.appendChild(bar);
    cell.appendChild(wv);
    grid.appendChild(cell);

    // Desabilita back/fwd inicialmente
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    
    // ── Keyboard Shortcuts ──
    const handleKeydown = (e) => {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 't' || e.key === 'T') {
                e.preventDefault();
                alert('Use o botão "+" na sidebar para adicionar uma nova conta');
            } else if (e.key === 'w' || e.key === 'W') {
                e.preventDefault();
                removeBtn.click();
            } else if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                reloadBtn.click();
            } else if (e.key === 'l' || e.key === 'L') {
                e.preventDefault();
                urlInput.focus();
                urlInput.select();
            } else if (e.key === 'k' || e.key === 'K') {
                e.preventDefault();
                // Força novo circuito
                mc.newIdentity(account.id).catch(err => {
                    console.error('Erro ao forçar novo circuito:', err);
                });
            } else if (e.key === 'd' || e.key === 'D') {
                e.preventDefault();
                // Abre DevTools
                wv.openDevTools();
            }
        }
    };

    document.addEventListener('keydown', handleKeydown);
    accountCleanups.set(account.id, () => {
        document.removeEventListener('keydown', handleKeydown);
        if (typeof wv.stop === "function") {
            try { wv.stop(); } catch (_) {}
        }
        wv.remove();
    });
    mc.getAccountHealth(account.id)
        .then(statusState => updateAccountStatus(account.id, statusState))
        .catch(() => {});
}

// Cria painéis, mas não carrega URLs de imediato
renderAllOverviewAccounts();

const groupList = document.getElementById("group-list");
const groupDialog = document.getElementById("group-dialog");
const groupNameInput = document.getElementById("group-name");
const groupCountInput = document.getElementById("group-count");
let activeGroupId = groups[0] ? groups[0].id : null;

document.getElementById("overview-btn").addEventListener("click", () => {
    grid.dataset.view = "overview";
    document.querySelectorAll(".group-btn").forEach(button => button.classList.remove("active"));
    updateOverviewGridLayout();
    applyVisibleAccounts();
});

document.getElementById("sort-overview-btn").addEventListener("click", () => {
    sortOverviewByGroup();
});

const groupContextMenu = document.getElementById("group-context-menu");

function closeGroupContextMenu() {
    groupContextMenu.classList.remove("visible");
    groupContextMenu.innerHTML = "";
}

function editGroup(groupId) {
    const group = groups.find(item => Number(item.id) === Number(groupId));
    if (!group) return;

    const dialog = document.getElementById("group-edit-dialog");
    const form = document.getElementById("group-edit-form");
    const idInput = document.getElementById("group-edit-id");
    const nameInput = document.getElementById("group-edit-name");
    const tagInput = document.getElementById("group-edit-tag");

    idInput.value = String(groupId);
    nameInput.value = group.name || "";
    tagInput.value = group.tag || "";

    if (dialog && form) {
        form.dataset.groupId = String(groupId);
        dialog.showModal();
        nameInput.focus();
        nameInput.select();
    }
    closeGroupContextMenu();
}

const groupEditDialog = document.getElementById("group-edit-dialog");
document.getElementById("cancel-group-edit-btn").addEventListener("click", () => {
    groupEditDialog.close();
});

document.getElementById("group-edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const groupId = document.getElementById("group-edit-id").value;
    const name = document.getElementById("group-edit-name").value;
    const tag = document.getElementById("group-edit-tag").value;
    const saveButton = document.getElementById("save-group-edit-btn");

    saveButton.disabled = true;
    saveButton.textContent = "Salvando...";

    try {
        const updatedGroup = await mc.updateGroup({ groupId, name, tag, note: "" });
        const index = groups.findIndex(item => Number(item.id) === Number(groupId));
        if (index >= 0) {
            groups[index] = updatedGroup;
            const button = document.querySelector(`.group-btn[data-group-id="${groupId}"]`);
            if (button) {
                button.innerHTML = `
                    <div class="group-btn-main">
                        <span class="group-btn-label">
                            <span class="group-color-dot" style="background:${getGroupColor(groupId)};"></span>
                            <span>${escapeHtml(updatedGroup.name)}</span>
                        </span>
                        <small>${updatedGroup.accounts.length}</small>
                    </div>
                    ${renderGroupButtonMeta(updatedGroup)}
                `;
            }
        }
        groupEditDialog.close();
    } catch (error) {
        window.alert(error.message || "Não foi possível atualizar o lote.");
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = "Salvar";
    }
});

function deleteGroup(groupId) {
    const group = groups.find(item => Number(item.id) === Number(groupId));
    if (!group) return;

    const confirmed = window.confirm(`Excluir o lote "${group.name}" e todas as ${group.accounts.length} contas? As partições Chromium e os diretórios Tor serão preservados.`);
    if (!confirmed) return;

    mc.deleteGroup(groupId).then(() => {
        const index = groups.findIndex(item => Number(item.id) === Number(groupId));
        if (index >= 0) {
            const removedGroup = groups[index];
            const accountIds = removedGroup.accounts.map(item => item.id);
            groups.splice(index, 1);
            accountIds.forEach(accountId => {
                const cell = document.querySelector(`.cell[data-account-id="${accountId}"]`);
                cleanupAccountPanel(accountId);
                if (cell) cell.remove();
                const accountIndex = accounts.findIndex(item => item.id === accountId);
                if (accountIndex >= 0) accounts.splice(accountIndex, 1);
            });
        }
        closeGroupContextMenu();
        if (groups.length && activeGroupId === Number(groupId)) {
            setActiveGroup(groups[0].id);
        }
        if (!groups.length) {
            activeGroupId = null;
            grid.dataset.view = "overview";
        }
        document.querySelectorAll(".group-btn").forEach(button => {
            if (Number(button.dataset.groupId) === Number(groupId)) button.remove();
        });
        updateOverviewGridLayout();
        applyVisibleAccounts();
    }).catch(error => {
        window.alert(error.message || "Não foi possível excluir o lote.");
    });
}

function showGroupContextMenu(event, groupId) {
    event.preventDefault();
    const group = groups.find(item => Number(item.id) === Number(groupId));
    if (!group) return;

    const menu = [
        { label: "Editar lote", action: () => editGroup(groupId) },
        { label: "Excluir lote", action: () => deleteGroup(groupId), danger: true },
    ];

    groupContextMenu.innerHTML = menu.map(item => `
        <button type="button" class="group-menu-item ${item.danger ? "danger" : ""}" data-action="${item.label}">${item.label}</button>
    `).join("");
	groupContextMenu.querySelectorAll(".group-menu-item").forEach((button, index) => {
	    button.addEventListener("click", () => menu[index].action());
	});

    groupContextMenu.classList.add("visible");
    groupContextMenu.style.left = `${event.clientX}px`;
    groupContextMenu.style.top = `${event.clientY}px`;
}

function renderGroupButton(group) {
    const button = document.createElement("button");
    button.className = "group-btn";
    button.dataset.groupId = group.id;
    const color = getGroupColor(group.id);
    button.innerHTML = `
        <div class="group-btn-main">
            <span class="group-btn-label">
                <span class="group-color-dot" style="background:${color};"></span>
                <span>${escapeHtml(group.name)}</span>
            </span>
            <small>${group.accounts.length}</small>
        </div>
        ${renderGroupButtonMeta(group)}
    `;
    button.addEventListener("click", () => setActiveGroup(group.id));
    button.addEventListener("contextmenu", (event) => showGroupContextMenu(event, group.id));
    groupList.appendChild(button);
}

function updateGroupButton(groupId) {
    const group = groups.find(item => item.id === groupId);
    const button = document.querySelector(`.group-btn[data-group-id="${groupId}"]`);
    if (group && button) {
        button.querySelector("small").textContent = group.accounts.length;
        button.querySelector(".group-color-dot").style.background = getGroupColor(group.id);
        const metaWrap = button.querySelector(".group-btn-meta");
        if (metaWrap) {
            metaWrap.innerHTML = `${group.tag ? `<span class="group-tag" title="Tag: ${escapeHtml(group.tag)}">${escapeHtml(group.tag)}</span>` : ""}`;
        } else if (group.tag) {
            const wrap = document.createElement("div");
            wrap.className = "group-btn-meta";
            wrap.innerHTML = `<span class="group-tag" title="Tag: ${escapeHtml(group.tag)}">${escapeHtml(group.tag)}</span>`;
            button.appendChild(wrap);
        }
    }
}

document.getElementById("add-account-btn").addEventListener("click", async () => {
    if (!activeGroupId) return;
    const button = document.getElementById("add-account-btn");
    button.disabled = true;
    button.textContent = "Iniciando...";
    try {
        await mc.addAccount(activeGroupId);
    } catch (error) {
        window.alert(error.message || "Não foi possível adicionar a conta.");
    } finally {
        button.disabled = false;
        button.textContent = "+ Conta no lote";
    }
});

function setActiveGroup(groupId) {
    activeGroupId = groupId;
    if (grid.classList.contains("layout-focus")) exitFocus();
    grid.dataset.view = "group";
    document.querySelectorAll(".group-btn").forEach(button => {
        button.classList.toggle("active", Number(button.dataset.groupId) === groupId);
    });
    updateOverviewGridLayout();
    applyVisibleAccounts();
}

function sortOverviewByGroup() {
    const orderedIds = [...accounts]
        .sort((a, b) => {
            const groupDiff = Number(a.batchId) - Number(b.batchId);
            return groupDiff !== 0 ? groupDiff : Number(a.id) - Number(b.id);
        })
        .map(account => account.id);

    overviewOrder = orderedIds;
    persist(api.storage.setOverviewOrder(orderedIds));

    const cells = [...document.querySelectorAll(".cell")].sort((a, b) => {
        return orderedIds.indexOf(Number(a.dataset.accountId)) - orderedIds.indexOf(Number(b.dataset.accountId));
    });

    cells.forEach(cell => grid.appendChild(cell));
    updateOverviewGridLayout();
    applyVisibleAccounts();
}

function renderAllOverviewAccounts() {
    const ordered = getOrderedAccountIds();
    ordered.forEach(accountId => {
        const account = accounts.find(item => item.id === Number(accountId));
        if (account && !document.querySelector(`.cell[data-account-id="${account.id}"]`)) {
            createAccountPanel(account);
        }
    });
    updateOverviewGridLayout();
}

groups.forEach(renderGroupButton);
if (groups[0]) setActiveGroup(groups[0].id);

document.getElementById("new-group-btn").addEventListener("click", () => {
    groupNameInput.value = `Lote ${groups.length + 1}`;
    groupCountInput.value = 4;
    groupDialog.showModal();
});

document.getElementById("cancel-group-btn").addEventListener("click", () => groupDialog.close());
document.getElementById("group-form").addEventListener("submit", async event => {
    event.preventDefault();
    const submitButton = document.getElementById("save-group-btn");
    submitButton.disabled = true;
    submitButton.textContent = "Iniciando...";
    try {
        await mc.createGroup({ name: groupNameInput.value, accountCount: groupCountInput.value });
        groupDialog.close();
    } catch (error) {
        window.alert(error.message || "Não foi possível criar o grupo.");
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Criar";
    }
});

mc.onGroupCreated(({ group, accounts: newAccounts }) => {
    groups.push(group);
    newAccounts.forEach(account => {
        accounts.push(account);
        bootProgress[account.id] = 100;
        if (grid.dataset.view === "overview") {
            createAccountPanel(account);
        }
    });
    syncOverviewOrder();
    renderGroupButton(group);
    setActiveGroup(group.id);
});

mc.onAccountAdded(account => {
    accounts.push(account);
    const group = groups.find(item => item.id === account.batchId);
    if (group) group.accounts.push({ id: account.id, name: account.name });
    syncOverviewOrder();
    if (!document.querySelector(`.cell[data-account-id="${account.id}"]`)) {
        createAccountPanel(account);
    }
    updateGroupButton(account.batchId);
    setActiveGroup(account.batchId);
});

mc.onAccountRemoved(accountId => {
    const cell = document.querySelector(`.cell[data-account-id="${accountId}"]`);
    const account = accounts.find(item => item.id === accountId);
    cleanupAccountPanel(accountId);
    if (cell) cell.remove();
    if (account) {
        const group = groups.find(item => item.id === account.batchId);
        if (group) group.accounts = group.accounts.filter(item => item.id !== accountId);
        updateGroupButton(account.batchId);
    }
    const accountIndex = accounts.findIndex(item => item.id === accountId);
    if (accountIndex >= 0) accounts.splice(accountIndex, 1);
    syncOverviewOrder();
    updateOverviewGridLayout();
    applyVisibleAccounts();
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "F5") return;
    event.preventDefault();
    reloadAllAccounts();
});

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════

function makeNavBtn(symbol, label) {
    const btn = document.createElement("button");
    btn.className = "nav-btn";
    btn.textContent = symbol;
    btn.title = label;
    return btn;
}

// — Histórico de URLs por conta —
const MAX_HISTORY = 12;

function loadHistory(accountId, datalist) {
    const saved = profileData(accountId).urlHistory;
    datalist.innerHTML = "";
    saved.forEach(url => {
        const opt = document.createElement("option");
        opt.value = url;
        datalist.appendChild(opt);
    });
}

function pushHistory(accountId, url, datalist) {
    if (!url || url === "about:blank") return;
    let saved = profileData(accountId).urlHistory;
    if (saved[0] === url) return;
    saved = saved.filter(u => u !== url);
    saved.unshift(url);
    if (saved.length > MAX_HISTORY) saved = saved.slice(0, MAX_HISTORY);
    profileData(accountId).urlHistory = saved;
    persist(api.storage.addNavigationHistory({ profileId: accountId, url }));
    loadHistory(accountId, datalist);
}

function saveIp(accountId, ip) {
    let history = profileData(accountId).ipHistory;
    if (history[0] === ip) return;
    history = history.filter(item => item !== ip);
    history.unshift(ip);
    profileData(accountId).ipHistory = history.slice(0, 50);
    persist(api.storage.addIpHistory({ profileId: accountId, ip }));
}

function showIpHistory(account, accountName) {
    const history = profileData(account.id).ipHistory;
    document.getElementById("ip-dialog-title").textContent = `${accountName} · IPs usados`;
    const list = document.getElementById("ip-dialog-list");
    list.replaceChildren();
    for (const value of history.length ? history : ["Nenhum IP registrado ainda"]) {
        const item = document.createElement("li");
        item.textContent = value;
        list.appendChild(item);
    }
    document.getElementById("ip-dialog").showModal();
}

document.getElementById("close-ip-dialog").addEventListener("click", () => {
    document.getElementById("ip-dialog").close();
});

mc.onAccountHealth((statusState) => {
    const { accountId } = statusState;
    updateAccountStatus(accountId, statusState);
    const cell = document.querySelector(`.cell[data-account-id="${accountId}"]`);
    if (cell) {
        cell.dataset.health = statusState.status || "unknown";
    }
});
}).catch(error => {
    console.error("Falha ao iniciar a interface:", error);
    splashStatus.textContent = `❌ ${error.message || "Falha ao carregar dados"}`;
    splashStatus.style.color = "#ff5555";
});
