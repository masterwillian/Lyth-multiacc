const RuntimeState = Object.freeze({
    STOPPED: "STOPPED",
    STARTING: "STARTING",
    BOOTSTRAPPING: "BOOTSTRAPPING",
    READY: "READY",
    DEGRADED: "DEGRADED",
    TOR_FAILED: "TOR_FAILED",
    PROXY_FAILED: "PROXY_FAILED",
    ROUTE_FAILED: "ROUTE_FAILED",
    LEAK_DETECTED: "LEAK_DETECTED",
    RECOVERING: "RECOVERING",
    ERROR: "ERROR"
});

const allowedTransitions = new Map([
    [RuntimeState.STOPPED, new Set([RuntimeState.STARTING])],
    [RuntimeState.STARTING, new Set([RuntimeState.BOOTSTRAPPING, RuntimeState.TOR_FAILED, RuntimeState.ERROR, RuntimeState.STOPPED])],
    [RuntimeState.BOOTSTRAPPING, new Set([RuntimeState.READY, RuntimeState.TOR_FAILED, RuntimeState.PROXY_FAILED, RuntimeState.ERROR, RuntimeState.STOPPED])],
    [RuntimeState.READY, new Set([RuntimeState.DEGRADED, RuntimeState.ROUTE_FAILED, RuntimeState.LEAK_DETECTED, RuntimeState.RECOVERING, RuntimeState.STOPPED, RuntimeState.ERROR])],
    [RuntimeState.DEGRADED, new Set([RuntimeState.READY, RuntimeState.RECOVERING, RuntimeState.TOR_FAILED, RuntimeState.STOPPED, RuntimeState.ERROR])],
    [RuntimeState.TOR_FAILED, new Set([RuntimeState.RECOVERING, RuntimeState.STARTING, RuntimeState.STOPPED])],
    [RuntimeState.PROXY_FAILED, new Set([RuntimeState.RECOVERING, RuntimeState.STARTING, RuntimeState.STOPPED])],
    [RuntimeState.ROUTE_FAILED, new Set([RuntimeState.READY, RuntimeState.RECOVERING, RuntimeState.STOPPED])],
    [RuntimeState.LEAK_DETECTED, new Set([RuntimeState.READY, RuntimeState.RECOVERING, RuntimeState.STOPPED])],
    [RuntimeState.RECOVERING, new Set([RuntimeState.BOOTSTRAPPING, RuntimeState.READY, RuntimeState.TOR_FAILED, RuntimeState.PROXY_FAILED, RuntimeState.ERROR, RuntimeState.STOPPED])],
    [RuntimeState.ERROR, new Set([RuntimeState.RECOVERING, RuntimeState.STARTING, RuntimeState.STOPPED])]
]);

function canTransition(from, to) {
    return from === to || Boolean(allowedTransitions.get(from)?.has(to));
}

function rendererStatus(state) {
    if (state === RuntimeState.READY) return "ready";
    if (state === RuntimeState.RECOVERING) return "recovering";
    if (state === RuntimeState.DEGRADED || state === RuntimeState.ROUTE_FAILED) return "degraded";
    if (state === RuntimeState.STARTING || state === RuntimeState.BOOTSTRAPPING) return "starting";
    if (state === RuntimeState.STOPPED) return "stopped";
    return "error";
}

module.exports = { RuntimeState, canTransition, rendererStatus };
