const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel) {
    return (...args) => ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, { once = false } = {}) {
    return callback => {
        if (typeof callback !== "function") throw new TypeError("callback must be a function");
        const listener = (_event, ...args) => callback(...args);
        if (once) ipcRenderer.once(channel, listener);
        else ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    };
}

const api = {
    app: Object.freeze({
        getVersion: invoke("get-app-version")
    }),
    workspace: Object.freeze({
        get: invoke("get-workspace"),
        createGroup: invoke("create-group"),
        updateGroup: invoke("update-group"),
        deleteGroup: invoke("delete-group"),
        onGroupCreated: subscribe("group-created")
    }),
    profiles: Object.freeze({
        rename: invoke("rename-account"),
        add: invoke("add-account"),
        remove: invoke("remove-account"),
        onAdded: subscribe("account-added"),
        onRemoved: subscribe("account-removed")
    }),
    tor: Object.freeze({
        newIdentity: invoke("tor-new-identity"),
        getCircuitInfo: invoke("get-circuit-info"),
        onBootstrapProgress: subscribe("bootstrap-progress"),
        onBootComplete: subscribe("tor-boot-complete", { once: true }),
        onBootError: subscribe("tor-boot-error", { once: true })
    }),
    health: Object.freeze({
        get: invoke("get-account-health"),
        checkRoute: invoke("check-leaks"),
        onUpdate: subscribe("account-health-update")
    }),
    storage: Object.freeze({
        importLegacyRendererData: invoke("storage-import-legacy-renderer"),
        setOverviewOrder: invoke("storage-set-overview-order"),
        setLastUrl: invoke("storage-set-last-url"),
        addNavigationHistory: invoke("storage-add-navigation-history"),
        replaceBookmarks: invoke("storage-replace-bookmarks"),
        addIpHistory: invoke("storage-add-ip-history")
    })
};

contextBridge.exposeInMainWorld("lyth", Object.freeze(api));
