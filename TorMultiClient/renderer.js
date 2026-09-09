// renderer.js — Processo renderer (sem Node.js direto)
// Acessa APIs via window.multiClient (contextBridge)

const mc      = window.multiClient;
const grid    = document.getElementById("grid");
const splash  = document.getElementById("splash");
const overviewOrderKey = "multiclient-overview-order";
const groupColors = [
    "#7c6fff", "#3ddc84", "#ffb84d", "#ff6b6b", "#5ad0ff",
    "#d77dff", "#7be0c3", "#ff9bd2", "#f9d65c", "#74c69d",
    "#ff7f50", "#70e000", "#00b4d8", "#f72585", "#ff9f1c",
    "#9b5de5", "#00bbf9", "#80ed99", "#ffb703", "#fb8500"
];

mc.getWorkspace().then(({ accounts: initialAccounts, groups }) => {
let accounts = initialAccounts;

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
    const stored = JSON.parse(localStorage.getItem(overviewOrderKey) || "[]");
    const merged = [...new Set([...(stored || []).filter(id => validIds.includes(Number(id))), ...validIds])];
    localStorage.setItem(overviewOrderKey, JSON.stringify(merged));
    return merged;
}

function getOrderedAccountIds() {
    const order = syncOverviewOrder();
    return order.filter(id => accounts.some(account => account.id === Number(id)));
}

function updateOverviewGridLayout() {
    if (grid.dataset.view !== "overview" || grid.classList.contains("layout-focus")) return;
    const total = accounts.length || 1;
    const columns = Math.max(1, Math.ceil(Math.sqrt(total)));
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
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
    localStorage.setItem(overviewOrderKey, JSON.stringify(order));

    const sourceCell = document.querySelector(`.cell[data-account-id="${sourceId}"]`);
    const targetCell = document.querySelector(`.cell[data-account-id="${targetId}"]`);
    if (!sourceCell || !targetCell || !sourceCell.parentNode) return;

    const ref = targetCell.nextSibling;
    sourceCell.parentNode.insertBefore(sourceCell, ref);
}

let appBootCompleted = false;

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
    splashStatus.textContent = "✅ Todos prontos! Carregando…";
    
    // Cada webview só navega depois que o guest about:blank estiver pronto.
    Object.keys(initialPageLoaders).forEach(accountId => {
        initialPageLoaders[accountId]();
    });
    
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

document.querySelectorAll(".layout-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const layout = btn.dataset.layout;
        setLayout(layout);
    });
});

function setLayout(layout) {
    document.querySelectorAll(".layout-btn").forEach(b => b.classList.remove("active"));
    const btn = document.querySelector(`[data-layout="${layout}"]`);
    if (btn) btn.classList.add("active");

    grid.className = `layout-${layout}`;
    applyVisibleAccounts();

    // Ao sair do foco, restaura todas as células
    if (layout !== "focus") {
        document.querySelectorAll(".cell").forEach(c => c.classList.remove("focused"));
        focusedAccountId = null;
        applyVisibleAccounts();
    }
}

function focusCell(accountId) {
    focusedAccountId = accountId;
    setLayout("focus");

    document.querySelectorAll(".layout-btn").forEach(b => b.classList.remove("active"));

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
const initialPageLoaders = {};
const DEFAULT_START_URL = "https://checkip.amazonaws.com/";

function isPersistableUrl(url) {
    return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
}

function getInitialAccountUrl(accountId) {
    const savedUrl = localStorage.getItem(`account-url-${accountId}`);
    if (isPersistableUrl(savedUrl)) return savedUrl;

    try {
        const history = JSON.parse(localStorage.getItem(historyKey(accountId)) || "[]");
        const recoveredUrl = history.find(isPersistableUrl);
        if (recoveredUrl) {
            localStorage.setItem(`account-url-${accountId}`, recoveredUrl);
            return recoveredUrl;
        }
    } catch (_) {}

    localStorage.setItem(`account-url-${accountId}`, DEFAULT_START_URL);
    return DEFAULT_START_URL;
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
    const savedName = localStorage.getItem(`account-name-${account.id}`) || account.name;
    label.textContent = savedName;
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
            localStorage.setItem(`account-name-${account.id}`, newName);
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
    urlInput.value = getInitialAccountUrl(account.id);
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
            if (result.verified && result.currentIP) {
                saveIp(account.id, result.currentIP);
                ipBadge.className = "ip-badge ready";
                ipBadge.textContent = result.currentIP;
                ipBadge.title = result.changed
                    ? "Novo circuito confirmado com IP diferente"
                    : "Novo circuito confirmado; o Tor manteve o mesmo exit relay";
            } else {
                ipBadge.className = "ip-badge error";
                ipBadge.textContent = "⚠ IP não verificado";
            }
            const wv = webviews[account.id];
            if (wv) wv.reloadIgnoringCache();
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
            setLayout("2x2");
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
    wv.setAttribute("allowpopups", "");
    wv.setAttribute("src", "about:blank");
    webviews[account.id] = wv;
    wv.dataset.initialUrl = urlInput.value;

    let guestReady = false;
    let initialNavigationStarted = false;
    function loadInitialPage() {
        // O dom-ready inicial pode ocorrer antes do listener em versões do Electron.
        if (!guestReady && wv.getURL() === "about:blank") guestReady = true;
        if (!appBootCompleted || !guestReady || initialNavigationStarted) return;
        const initialUrl = wv.dataset.initialUrl;
        if (!initialUrl) return;
        initialNavigationStarted = true;
        wv.loadURL(initialUrl).catch(error => {
            initialNavigationStarted = false;
            console.error(`Não foi possível carregar a URL inicial da conta ${account.id}:`, error);
        });
    }
    initialPageLoaders[account.id] = loadInitialPage;
    wv.addEventListener("dom-ready", () => {
        if (!initialNavigationStarted && wv.getURL() === "about:blank") {
            guestReady = true;
            loadInitialPage();
        }
    });

    // — Navegação —
    function navigate() {
        let url = urlInput.value.trim();
        if (!url) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
            urlInput.value = url;
        }
        localStorage.setItem(`account-url-${account.id}`, url);
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
        if (!isPersistableUrl(e.url)) return;
        urlInput.value = e.url;
        localStorage.setItem(`account-url-${account.id}`, e.url);
        pushHistory(account.id, e.url, datalist);
    });

    wv.addEventListener("did-navigate-in-page", e => {
        if (e.isMainFrame && isPersistableUrl(e.url)) {
            urlInput.value = e.url;
            localStorage.setItem(`account-url-${account.id}`, e.url);
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

    // — Detecção de IP + Canvas Fingerprinting Protection ──
    wv.addEventListener("did-finish-load", () => {
        // Injeta proteção contra Canvas Fingerprinting
        const canvasProtectionScript = `
(function() {
    // Protege Canvas.toDataURL
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
        if (this.width === 0 || this.height === 0) {
            return originalToDataURL.call(this, type);
        }
        const ctx = this.getContext('2d');
        if (ctx) {
            ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',0.5)';
            ctx.fillRect(0, 0, 1, 1);
        }
        return originalToDataURL.call(this, type);
    };
    
    // Protege Canvas.toBlob
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
            ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',0.5)';
            ctx.fillRect(0, 0, 1, 1);
        }
        return originalToBlob.call(this, callback, type, quality);
    };
    
    // Protege WebGL Fingerprinting
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, parameter);
    };
    
    // Protege WebGL2
    if (WebGL2RenderingContext) {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter2.call(this, parameter);
        };
    }
})();
`;
        try {
            wv.executeJavaScript(canvasProtectionScript);
        } catch (e) {
            console.log('Canvas protection injection skipped');
        }

        // Detecção de IP
        wv.executeJavaScript(`
            (() => {
                const txt = document.body ? document.body.innerText.trim() : "";
                try {
                    const obj = JSON.parse(txt);
                    if (obj.ip) return obj.ip;
                } catch (_) {}
                const m = txt.match(/\\b(\\d{1,3}\\.){3}\\d{1,3}\\b/);
                return m ? m[0] : null;
            })()
        `).then(ip => {
            if (ip) {
                saveIp(account.id, ip);
                ipBadge.className = "ip-badge ready";
                ipBadge.textContent = `${ip}`;
            } else {
                ipBadge.className = "ip-badge loading";
                ipBadge.textContent = `Tor :${account.torPort}`;
            }
        }).catch(() => {
            ipBadge.className = "ip-badge loading";
            ipBadge.textContent = `Tor :${account.torPort}`;
        });
    });

    wv.addEventListener("did-fail-load", (e) => {
        if (e.errorCode === -3) return;
        ipBadge.className = "ip-badge error";
        ipBadge.textContent = `⚠ ${e.errorCode}`;
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

    // Carrega bookmarks do localStorage
    const bookmarksKey = `bookmarks-${account.id}`;
    const bookmarks = JSON.parse(localStorage.getItem(bookmarksKey) || "[]");

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

        localStorage.setItem(bookmarksKey, JSON.stringify(bookmarks));
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
        bookmarkMenu.innerHTML = bookmarks.length ? 
            bookmarks.map((b, i) => `
                <div style="padding: 8px; border-bottom: 1px solid #333; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onmouseover="this.style.background='#333'" onmouseout="this.style.background=''">
                    <span onclick="document.querySelector('[data-account-id=\"${account.id}\"] .url-input').value='${b.url}'; document.querySelector('[data-account-id=\"${account.id}\"] .url-input').dispatchEvent(new Event('keydown', {key: 'Enter'}))" style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px;">${b.url}</span>
                    <span onclick="event.stopPropagation(); bookmarks.splice(${i}, 1); localStorage.setItem('${bookmarksKey}', JSON.stringify(bookmarks)); updateBookmarkMenu();" style="cursor: pointer; color: #f00; margin-left: 8px;">✕</span>
                </div>
            `).join('') :
            '<div style="padding: 8px; color: #888;">Nenhum favorito</div>';
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
                mc.openDevTools(account.id);
            }
        }
    };

    document.addEventListener('keydown', handleKeydown);
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

    const confirmed = window.confirm(`Excluir o lote "${group.name}" e todas as ${group.accounts.length} contas?`);
    if (!confirmed) return;

    mc.deleteGroup(groupId).then(() => {
        const index = groups.findIndex(item => Number(item.id) === Number(groupId));
        if (index >= 0) {
            const removedGroup = groups[index];
            const accountIds = removedGroup.accounts.map(item => item.id);
            groups.splice(index, 1);
            accountIds.forEach(accountId => {
                const cell = document.querySelector(`.cell[data-account-id="${accountId}"]`);
                if (cell) cell.remove();
                const accountIndex = accounts.findIndex(item => item.id === accountId);
                if (accountIndex >= 0) accounts.splice(accountIndex, 1);
                delete webviews[accountId];
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
    if (grid.classList.contains("layout-focus")) setLayout("2x2");
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

    localStorage.setItem(overviewOrderKey, JSON.stringify(orderedIds));

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
    if (cell) cell.remove();
    if (account) {
        const group = groups.find(item => item.id === account.batchId);
        if (group) group.accounts = group.accounts.filter(item => item.id !== accountId);
        updateGroupButton(account.batchId);
    }
    const accountIndex = accounts.findIndex(item => item.id === accountId);
    if (accountIndex >= 0) accounts.splice(accountIndex, 1);
    syncOverviewOrder();
    delete webviews[accountId];
    delete ipBadges[accountId];
    delete initialPageLoaders[accountId];
    updateOverviewGridLayout();
    applyVisibleAccounts();
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "F5") return;
    event.preventDefault();
    reloadAllAccounts();
});

// ══════════════════════════════════════════════════
// DevTools relay (main → renderer)
// ══════════════════════════════════════════════════
mc.onOpenDevTools((accountId) => {
    const wv = webviews[accountId];
    if (wv) wv.openDevTools();
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

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// — Histórico de URLs por conta —
const MAX_HISTORY = 12;

function historyKey(accountId) {
    return `url-history-${accountId}`;
}

function loadHistory(accountId, datalist) {
    let saved = [];
    try {
        saved = JSON.parse(localStorage.getItem(historyKey(accountId)) || "[]").filter(isPersistableUrl);
    } catch (_) {}
    datalist.innerHTML = "";
    saved.forEach(url => {
        const opt = document.createElement("option");
        opt.value = url;
        datalist.appendChild(opt);
    });
}

function pushHistory(accountId, url, datalist) {
    if (!isPersistableUrl(url)) return;
    const key = historyKey(accountId);
    let saved = JSON.parse(localStorage.getItem(key) || "[]");
    saved = saved.filter(u => u !== url);
    saved.unshift(url);
    if (saved.length > MAX_HISTORY) saved = saved.slice(0, MAX_HISTORY);
    localStorage.setItem(key, JSON.stringify(saved));
    loadHistory(accountId, datalist);
}

function ipHistoryKey(accountId) {
    return `ip-history-${accountId}`;
}

function saveIp(accountId, ip) {
    const key = ipHistoryKey(accountId);
    let history = JSON.parse(localStorage.getItem(key) || "[]");
    history = history.filter(item => item !== ip);
    history.unshift(ip);
    localStorage.setItem(key, JSON.stringify(history.slice(0, 50)));
}

function showIpHistory(account, accountName) {
    const history = JSON.parse(localStorage.getItem(ipHistoryKey(account.id)) || "[]");
    document.getElementById("ip-dialog-title").textContent = `${accountName} · IPs usados`;
    document.getElementById("ip-dialog-list").innerHTML = history.length
        ? history.map(ip => `<li>${ip}</li>`).join("")
        : "<li>Nenhum IP registrado ainda</li>";
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
});
