async function rotateIdentity(options) {
    const {
        getRoute,
        signalNewnym,
        resetConnections,
        wait,
        attempts = 3,
        delayForAttempt = attempt => 1500 * attempt
    } = options;

    const previousRoute = await getRoute("newnym-before").catch(() => null);
    try {
        await signalNewnym();
    } catch (error) {
        return {
            signalSucceeded: false,
            routeVerified: false,
            previousIP: previousRoute?.ip || null,
            currentIP: null,
            newIP: null,
            ipChanged: null,
            changed: null,
            isTor: null,
            error: error.message,
            message: `Falha ao solicitar novo circuito: ${error.message}`
        };
    }

    await resetConnections();
    let currentRoute = null;
    let routeError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await wait(delayForAttempt(attempt));
        try {
            currentRoute = await getRoute("newnym-after");
            routeError = null;
            if (currentRoute.isTor === true) break;
        } catch (error) {
            routeError = error;
        }
    }

    const routeVerified = currentRoute?.reachable === true && currentRoute?.isTor === true;
    const previousIP = previousRoute?.ip || null;
    const currentIP = currentRoute?.ip || null;
    const ipChanged = previousIP && currentIP ? previousIP !== currentIP : null;
    let message = "Circuito rotacionado, mas a rota ainda não foi verificada";
    if (routeVerified && ipChanged === false) message = "Novo circuito confirmado; o relay de saída manteve o mesmo IP";
    else if (routeVerified && ipChanged === true) message = "Novo circuito confirmado; o IP de saída mudou";
    else if (routeVerified) message = "Novo circuito e rota Chromium confirmados";

    return {
        signalSucceeded: true,
        routeVerified,
        previousIP,
        currentIP,
        newIP: currentIP,
        ipChanged,
        changed: ipChanged,
        isTor: currentRoute?.isTor ?? null,
        error: routeError?.message || currentRoute?.error || null,
        message
    };
}

module.exports = { rotateIdentity };
