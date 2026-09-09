const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("multiClient", {
    version: "0.2.0",

    getWorkspace: () => ipcRenderer.invoke("get-workspace"),
    createGroup: (data) => ipcRenderer.invoke("create-group", data),
    updateGroup: (data) => ipcRenderer.invoke("update-group", data),
    deleteGroup: (groupId) => ipcRenderer.invoke("delete-group", groupId),
    renameAccount: (data) => ipcRenderer.invoke("rename-account", data),
    addAccount: (groupId) => ipcRenderer.invoke("add-account", groupId),
    removeAccount: (accountId) => ipcRenderer.invoke("remove-account", accountId),
    onGroupCreated: (callback) => {
        ipcRenderer.on("group-created", (_, data) => callback(data));
    },
    onGroupDeleted: (callback) => {
        ipcRenderer.on("group-deleted", (_, groupId) => callback(groupId));
    },
    onAccountAdded: (callback) => {
        ipcRenderer.on("account-added", (_, account) => callback(account));
    },
    onAccountRemoved: (callback) => {
        ipcRenderer.on("account-removed", (_, accountId) => callback(accountId));
    },

    // Solicita novo circuito Tor para uma conta
    newIdentity: (accountId) => ipcRenderer.invoke("tor-new-identity", accountId),

    // Abre DevTools de uma webview (retransmitido pelo main)
    openDevTools: (accountId) => ipcRenderer.send("open-devtools", accountId),

    // Escuta progresso de bootstrap (0–100) de cada instância
    onBootstrapProgress: (callback) => {
        ipcRenderer.on("bootstrap-progress", (_, data) => callback(data));
    },

    // Escuta alteração de status e saúde da conta
    onAccountHealth: (callback) => {
        ipcRenderer.on("account-health-update", (_, data) => callback(data));
    },

    // Solicita o estado atual de saúde da conta
    getAccountHealth: (accountId) => ipcRenderer.invoke("get-account-health", accountId),

    // Escuta conclusão do boot completo
    onBootComplete: (callback) => {
        ipcRenderer.once("tor-boot-complete", () => callback());
    },

    // Escuta erros de boot
    onBootError: (callback) => {
        ipcRenderer.once("tor-boot-error", (_, msg) => callback(msg));
    },

    // Recebe sinal para abrir DevTools (enviado pelo main como retransmissão)
    onOpenDevTools: (callback) => {
        ipcRenderer.on("open-devtools-reply", (_, accountId) => callback(accountId));
    },

    // Leak Detection
    checkLeaks: (payload) => ipcRenderer.invoke("check-leaks", payload),

    // Tor Circuit Info
    getCircuitInfo: (accountId) => ipcRenderer.invoke("get-circuit-info", accountId),
});
