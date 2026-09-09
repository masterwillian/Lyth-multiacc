const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("remove a API de detecção de vazamento que gerava falsa garantia", () => {
    const source = [read("main.js"), read("preload.js"), read("renderer.js")].join("\n");

    assert.doesNotMatch(source, /checkForLeaks|check-leaks|checkLeaks|hasLeak/);
});

test("não carrega fontes remotas na janela principal", () => {
    const html = read("index.html");

    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|@import\s+url/i);
    assert.match(html, /system-ui/);
    assert.match(html, /ui-monospace/);
});

test("usa a marca hub-bliw sem claims de múltiplos IPs", () => {
    const interfaceSource = [read("index.html"), read("main.js")].join("\n");

    assert.match(interfaceSource, /hub-bliw/);
    assert.doesNotMatch(interfaceSource, /4 IPs|IPs independentes|IPs separados|MultiClient/);
    assert.doesNotMatch(read("index.html"), /splash-subtitle|topbar-info/);
});

test("remove atalhos globais implementados pelo aplicativo", () => {
    const renderer = read("renderer.js");

    assert.doesNotMatch(renderer, /ctrlKey|metaKey|Keyboard Shortcuts|reloadAllAccounts/);
    assert.doesNotMatch(renderer, /document\.addEventListener\(["']keydown["']/);
    assert.match(read("main.js"), /win\.removeMenu\(\)/);
});

test("exibe a saúde e aceita IP somente do health-check", () => {
    const renderer = read("renderer.js");
    const main = read("main.js");

    assert.match(renderer, /bar\.append\(label, statusWrap,/);
    assert.match(renderer, /statusState\.currentIP/);
    assert.match(renderer, /mc\.getAccountHealth\(account\.id\)/);
    assert.doesNotMatch(renderer, /document\.body\.innerText/);
    assert.match(main, /status: "recovering",\s+message: "Solicitando novo circuito Tor",\s+currentIP: null/);
    assert.match(main, /status: "degraded",\s+message: "Não foi possível solicitar um novo circuito Tor",\s+currentIP: null/);
});
