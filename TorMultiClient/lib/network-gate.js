const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function isVerifiedReady(state = {}) {
    return state.status === "ready"
        && state.bootstrapped === true
        && state.circuitEstablished === true
        && state.proxyConfigured === true
        && typeof state.currentIP === "string"
        && state.currentIP.length > 0;
}

function shouldAllowRequest(rawUrl, accountId, allowedAccounts, verificationUrls) {
    const url = new URL(rawUrl);
    if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return true;
    if (allowedAccounts.has(accountId)) return true;

    return verificationUrls.get(accountId) === rawUrl
        && url.protocol === "https:"
        && url.hostname === "api.ipify.org";
}

function hasExpectedSocksProxy(resolvedProxy, port) {
    const expected = `127.0.0.1:${Number(port)}`;
    return String(resolvedProxy || "")
        .split(";")
        .map(entry => entry.trim().split(/\s+/))
        .some(([scheme, endpoint, ...rest]) =>
            /^SOCKS5?$/i.test(scheme || "") && endpoint === expected && rest.length === 0
        );
}

module.exports = { hasExpectedSocksProxy, isVerifiedReady, shouldAllowRequest };
