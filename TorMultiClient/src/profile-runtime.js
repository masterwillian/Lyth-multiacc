const { RuntimeState, canTransition, rendererStatus } = require("./runtime-states");

function emptyCheck(extra = {}) {
    return { checkedAt: null, error: null, ...extra };
}

function createHealth(profile) {
    return {
        process: emptyCheck({ alive: false }),
        bootstrap: emptyCheck({ complete: false, progress: 0 }),
        controlPort: emptyCheck({ available: false }),
        socks: emptyCheck({ available: false }),
        session: emptyCheck({ available: false }),
        proxy: emptyCheck({ configured: false, expected: `socks5://127.0.0.1:${profile.torPort}`, actual: null }),
        route: emptyCheck({ reachable: null, ip: null, reason: null }),
        torRoute: emptyCheck({ recognized: null })
    };
}

class ProfileRuntime {
    constructor(profile, dependencies) {
        this.profile = profile;
        this.dependencies = {
            healthIntervalMs: 15_000,
            externalHealthIntervalMs: 5 * 60_000,
            restartBackoffBaseMs: 5_000,
            restartBackoffMaxMs: 5 * 60_000,
            setIntervalFn: setInterval,
            clearIntervalFn: clearInterval,
            checkControlPort: async () => true,
            checkSocksPort: async () => true,
            inspectSessionProxy: async (_session, currentProfile) => ({
                configured: true,
                expected: `socks5://127.0.0.1:${currentProfile.torPort}`,
                actual: `SOCKS5 127.0.0.1:${currentProfile.torPort}`
            }),
            verifyExternalRoute: async () => ({ reachable: true, isTor: true, ip: "127.0.0.1" }),
            ...dependencies
        };
        this.state = RuntimeState.STOPPED;
        this.message = "Perfil parado";
        this.retries = 0;
        this.lastUpdated = Date.now();
        this.health = createHealth(profile);
        this.tor = null;
        this.session = null;
        this.healthTimer = null;
        this.operation = null;
        this.destroyed = false;
        this.healthCheckRunning = false;
        this.internalFailureCount = 0;
        this.recoveryFailures = 0;
        this.nextRecoveryAt = 0;
    }

    snapshot() {
        return {
            accountId: this.profile.id,
            state: this.state,
            status: rendererStatus(this.state),
            message: this.message,
            bootstrapped: this.health.bootstrap.complete,
            retries: this.retries,
            torPort: this.profile.torPort,
            controlPort: this.profile.controlPort,
            lastUpdated: this.lastUpdated,
            health: JSON.parse(JSON.stringify(this.health)),
            operation: this.operation?.name || null,
            recovery: { failures: this.recoveryFailures, nextAttemptAt: this.nextRecoveryAt || null }
        };
    }

    transition(nextState, message, patch = {}) {
        if (!canTransition(this.state, nextState)) {
            throw new Error(`Transição de runtime inválida: ${this.state} -> ${nextState}`);
        }
        const previousState = this.state;
        this.state = nextState;
        this.message = message || this.message;
        Object.assign(this, patch);
        this._emit(previousState, "runtime-state-transition");
        return this.snapshot();
    }

    start() {
        if (this.destroyed) return Promise.reject(new Error("O runtime foi destruído"));
        if (this.state === RuntimeState.READY) return Promise.resolve(this);
        return this._exclusive("start", () => this._start(false), true);
    }

    restart(reason = "Recuperação solicitada") {
        if (this.destroyed) return Promise.reject(new Error("O runtime foi destruído"));
        if (this.state === RuntimeState.STOPPED) return this.start();
        return this._exclusive("restart", async () => {
            this.retries += 1;
            this.transition(RuntimeState.RECOVERING, reason);
            await this._stopTor();
            if (this.session) await this._closeSessionConnections();
            return this._start(true);
        }, true);
    }

    async stop() {
        if (this.state === RuntimeState.STOPPED && !this.operation) return;
        this._clearHealthTimer();
        await this._stopTor();
        if (this.operation) await this.operation.promise.catch(() => {});
        return this._exclusive("stop", async () => {
            await this._stopResources();
            this._resetResourceHealth();
            if (this.state !== RuntimeState.STOPPED) this.transition(RuntimeState.STOPPED, "Perfil parado");
        }, true);
    }

    runOperation(name, task) {
        if (typeof name === "function") {
            task = name;
            name = "custom";
        }
        if (this.destroyed) return Promise.reject(new Error("O runtime foi destruído"));
        return this._exclusive(name, () => task(this), false);
    }

    async destroy() {
        if (this.destroyed && this.state === RuntimeState.STOPPED) return;
        this.destroyed = true;
        await this.stop();
    }

    async verifyExternalRoute({ force = false, reason = "periodic" } = {}) {
        if (!this.session) {
            const result = { reachable: false, isTor: null, ip: null, error: "Sessão Electron indisponível", reason };
            this._applyRouteResult(result);
            return result;
        }
        const now = this._now();
        const lastCheck = this.health.route.checkedAt || 0;
        if (!force && now - lastCheck < this.dependencies.externalHealthIntervalMs) {
            return {
                reachable: this.health.route.reachable,
                isTor: this.health.torRoute.recognized,
                ip: this.health.route.ip,
                error: this.health.route.error,
                reason: this.health.route.reason,
                cached: true
            };
        }

        let result;
        try {
            result = { ...(await this.dependencies.verifyExternalRoute(this.session, this.profile)), reason };
        } catch (error) {
            result = { reachable: false, isTor: null, ip: null, error: error.message, reason };
        }
        this._applyRouteResult(result);
        return result;
    }

    async checkHealthNow({ includeExternal = false, forceExternal = false, reason = "manual" } = {}) {
        await this._runInternalChecks();
        if (includeExternal) return this.verifyExternalRoute({ force: forceExternal, reason });
        return this.snapshot();
    }

    async _start(recovering) {
        if (this.destroyed) throw new Error("O runtime foi destruído");
        this._clearHealthTimer();
        this.transition(recovering ? RuntimeState.BOOTSTRAPPING : RuntimeState.STARTING,
            recovering ? "Reiniciando runtime" : "Configurando sessão fail-closed");

        try {
            this.session = await this.dependencies.createSession(this.profile);
            this.health.session = emptyCheck({ available: true, checkedAt: this._now() });
            await this._checkExpectedProxy();
            if (!this.health.proxy.configured) throw new Error("A sessão não está usando o proxy SOCKS esperado");
        } catch (error) {
            this._scheduleRecovery();
            this.transition(RuntimeState.PROXY_FAILED, `Falha ao configurar proxy: ${error.message}`);
            this._startHealthMonitor();
            throw error;
        }

        if (!recovering) this.transition(RuntimeState.BOOTSTRAPPING, "Aguardando bootstrap do Tor");
        try {
            const handle = this.dependencies.launchTor(this.profile, {
                onBootstrap: percent => this._recordBootstrap(percent),
                onExit: (code, wasBootstrapped) => this._handleTorExit(code, wasBootstrapped)
            });
            this.tor = handle;
            this.health.process = emptyCheck({ alive: true, checkedAt: this._now() });
            this._emit(this.state, "health-update");
            await handle.ready;
            this.health.bootstrap = emptyCheck({ complete: true, progress: 100, checkedAt: this._now() });
        } catch (error) {
            await this._stopTor();
            this._scheduleRecovery();
            this.transition(RuntimeState.TOR_FAILED, error.message);
            this._startHealthMonitor();
            throw error;
        }

        const internalHealthy = await this._runInternalChecks();
        if (!internalHealthy) {
            this._scheduleRecovery();
            this._startHealthMonitor();
            throw new Error(this.message);
        }

        await this.verifyExternalRoute({ force: true, reason: recovering ? "recovery" : "startup" });
        this.retries = Math.max(0, this.retries - (recovering ? 1 : 0));
        this.recoveryFailures = 0;
        this.nextRecoveryAt = 0;
        this._startHealthMonitor();
        return this;
    }

    _exclusive(name, task, coalesceSame) {
        if (this.operation) {
            if (coalesceSame && this.operation.name === name) return this.operation.promise;
            return Promise.reject(new Error(`Operação conflitante: ${this.operation.name} já está em andamento`));
        }
        const operation = Promise.resolve().then(task);
        const wrapped = operation.finally(() => {
            if (this.operation?.promise === wrapped) this.operation = null;
        });
        this.operation = { name, promise: wrapped };
        return wrapped;
    }

    _startHealthMonitor() {
        this._clearHealthTimer();
        this.healthTimer = this.dependencies.setIntervalFn(() => void this._checkHealth(), this.dependencies.healthIntervalMs);
    }

    _clearHealthTimer() {
        if (this.healthTimer) this.dependencies.clearIntervalFn(this.healthTimer);
        this.healthTimer = null;
    }

    async _checkHealth() {
        if (this.healthCheckRunning || this.destroyed || this.state === RuntimeState.STOPPED) return;
        this.healthCheckRunning = true;
        try {
            const internalHealthy = await this._runInternalChecks();
            if (!internalHealthy) {
                this.internalFailureCount += 1;
                if (this.internalFailureCount >= 2 && this._now() >= this.nextRecoveryAt) {
                    await this.restart("Recuperando falha interna");
                }
                return;
            }
            this.internalFailureCount = 0;
            if (this.state === RuntimeState.DEGRADED) this.transition(RuntimeState.READY, "Verificações internas recuperadas");
            await this.verifyExternalRoute({ force: false, reason: "periodic" });
        } catch (error) {
            if (!this.destroyed && !String(error.message).startsWith("Operação conflitante")) {
                const expectedFailure = this.state === RuntimeState.TOR_FAILED
                    || this.state === RuntimeState.PROXY_FAILED;
                if (!expectedFailure) this._scheduleRecovery();
                if (!expectedFailure && canTransition(this.state, RuntimeState.ERROR)) {
                    this.transition(RuntimeState.ERROR, error.message || "Falha no monitor de saúde");
                }
            }
        } finally {
            this.healthCheckRunning = false;
        }
    }

    async _runInternalChecks() {
        const now = this._now();
        const processAlive = this.tor?.process?.exitCode === null && !this.tor.process.killed;
        this.health.process = emptyCheck({ alive: Boolean(processAlive), checkedAt: now });
        this.health.session = emptyCheck({ available: Boolean(this.session), checkedAt: now });
        const [control, socks] = await Promise.all([
            this.dependencies.checkControlPort(this.profile.controlPort),
            this.dependencies.checkSocksPort(this.profile.torPort)
        ]);
        this.health.controlPort = emptyCheck({ available: Boolean(control), checkedAt: now });
        this.health.socks = emptyCheck({ available: Boolean(socks), checkedAt: now });
        await this._checkExpectedProxy();

        if (!processAlive) this._setFailureState(RuntimeState.DEGRADED, "Processo Tor indisponível");
        else if (!this.health.bootstrap.complete) this._setFailureState(RuntimeState.DEGRADED, "Bootstrap Tor incompleto");
        else if (!control) this._setFailureState(RuntimeState.DEGRADED, "ControlPort indisponível");
        else if (!socks) this._setFailureState(RuntimeState.DEGRADED, "Proxy SOCKS indisponível");
        else if (!this.session) this._setFailureState(RuntimeState.PROXY_FAILED, "Sessão Electron indisponível");
        else if (!this.health.proxy.configured) this._setFailureState(RuntimeState.PROXY_FAILED, "Proxy da sessão diverge do esperado");
        else {
            this._emit(this.state, "health-update");
            return true;
        }
        return false;
    }

    async _checkExpectedProxy() {
        const now = this._now();
        const expected = `socks5://127.0.0.1:${this.profile.torPort}`;
        if (!this.session) {
            this.health.proxy = emptyCheck({ configured: false, expected, actual: null, checkedAt: now, error: "Sessão Electron indisponível" });
            return false;
        }
        try {
            const result = await this.dependencies.inspectSessionProxy(this.session, this.profile);
            this.health.proxy = emptyCheck({ configured: result.configured === true, expected: result.expected, actual: result.actual, checkedAt: now });
        } catch (error) {
            this.health.proxy = emptyCheck({ configured: false, expected, actual: null, checkedAt: now, error: error.message });
        }
        return this.health.proxy.configured;
    }

    _applyRouteResult(result) {
        const now = this._now();
        this.health.route = emptyCheck({
            reachable: result.reachable === true,
            ip: result.ip || null,
            reason: result.reason || null,
            checkedAt: now,
            error: result.error || null
        });
        this.health.torRoute = emptyCheck({
            recognized: result.isTor === true ? true : result.isTor === false ? false : null,
            checkedAt: now,
            error: result.error || null
        });

        if (!result.reachable) this._setFailureState(RuntimeState.ROUTE_FAILED, "A rota Chromium não respondeu");
        else if (result.isTor !== true) this._setFailureState(RuntimeState.LEAK_DETECTED, "A rota Chromium não foi reconhecida como Tor");
        else if (this.state !== RuntimeState.READY && canTransition(this.state, RuntimeState.READY)) {
            this.transition(RuntimeState.READY, "Rota Chromium confirmada pela rede Tor");
        } else {
            this.message = "Rota Chromium confirmada pela rede Tor";
            this._emit(this.state, "health-update");
        }
    }

    _setFailureState(state, message) {
        if (this.state === state) {
            this.message = message;
            this._emit(this.state, "health-update");
        } else if (canTransition(this.state, state)) {
            this.transition(state, message);
        } else {
            this._emit(this.state, "health-update");
        }
    }

    _recordBootstrap(percent) {
        this.health.bootstrap = emptyCheck({ complete: percent === 100, progress: percent, checkedAt: this._now() });
        this.dependencies.onBootstrap?.(this.profile.id, percent);
        this._emit(this.state, "health-update");
    }

    _scheduleRecovery() {
        this.recoveryFailures += 1;
        const delay = Math.min(
            this.dependencies.restartBackoffMaxMs,
            this.dependencies.restartBackoffBaseMs * (2 ** Math.max(0, this.recoveryFailures - 1))
        );
        this.nextRecoveryAt = this._now() + delay;
    }

    async _stopTor() {
        const tor = this.tor;
        this.tor = null;
        try { tor?.stop(); } catch (error) { this.dependencies.onCleanupError?.(error); }
        this.health.process = emptyCheck({ alive: false, checkedAt: this._now() });
        this.health.bootstrap = emptyCheck({ complete: false, progress: 0, checkedAt: this._now() });
    }

    async _closeSessionConnections() {
        try { await this.session?.closeAllConnections(); }
        catch (error) { this.dependencies.onCleanupError?.(error); }
    }

    async _stopResources() {
        this._clearHealthTimer();
        await this._stopTor();
        await this._closeSessionConnections();
        this.session = null;
    }

    _resetResourceHealth() {
        const route = this.health.route;
        const torRoute = this.health.torRoute;
        this.health = createHealth(this.profile);
        this.health.route = route;
        this.health.torRoute = torRoute;
    }

    _handleTorExit(code, wasBootstrapped) {
        this.health.process = emptyCheck({ alive: false, checkedAt: this._now() });
        if (this.destroyed || this.state === RuntimeState.STOPPED || this.state === RuntimeState.RECOVERING) return;
        if (wasBootstrapped) {
            this._scheduleRecovery();
            this._setFailureState(RuntimeState.DEGRADED, `Instância Tor encerrou (code=${code})`);
        }
    }

    _emit(previousState, event) {
        this.lastUpdated = this._now();
        this.dependencies.onStateChange?.(this.snapshot(), previousState, event);
    }

    _now() {
        return this.dependencies.now?.() ?? Date.now();
    }
}

module.exports = { ProfileRuntime, createHealth };
