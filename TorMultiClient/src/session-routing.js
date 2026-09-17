async function configureFailClosedSession(ses, profile) {
    const expected = `socks5://127.0.0.1:${profile.torPort}`;
    ses.enableNetworkEmulation({ offline: true });
    await ses.setProxy({
        mode: "fixed_servers",
        proxyRules: expected,
        proxyBypassRules: "<-loopback>"
    });
    await ses.closeAllConnections();
    ses.disableNetworkEmulation();
    return ses;
}

async function inspectSessionProxy(ses, profile) {
    const expected = `socks5://127.0.0.1:${profile.torPort}`;
    const actual = await ses.resolveProxy("https://check.torproject.org/");
    const normalized = String(actual || "").toLowerCase();
    const configured = normalized.includes(`socks5 127.0.0.1:${profile.torPort}`)
        || normalized.includes(`socks 127.0.0.1:${profile.torPort}`);
    return { expected, actual, configured };
}

module.exports = { configureFailClosedSession, inspectSessionProxy };
