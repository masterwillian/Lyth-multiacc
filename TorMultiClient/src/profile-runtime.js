const { RuntimeState, canTransition, rendererStatus } = require("./runtime-states");

class ProfileRuntime {
    constructor(profile, dependencies) {
        this.profile = profile;
        this.dependencies = dependencies;
        this.state = RuntimeState.STOPPED;
        this.message = "Perfil parado";
        this.retries = 0;
        this.lastUpdated = Date.now();
        this.tor = null;
        this.session = null;
        this.healthTimer = null;
        this.operation = null;
        this.destroyed = false;
        this.healthCheckRunning = false;
    }

    snapshot() {
        return {
            accountId: this.profile.id,
            state: this.state,
            status: rendererStatus(this.state),
            message: this.message,
            bootstrapped: this.state === RuntimeState.READY,
            retries: this.retries,
            torPort: this.profile.torPort,
            controlPort: this.profile.controlPort,
            lastUpdated: this.lastUpdated
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
        this.lastUpdated = Date.now();
        const snapshot = this.snapshot();
        this.dependencies.onStateChange?.(snapshot, previousState);
        return snapshot;
    }

    start() {
        return this._exclusive(() => this._start(false));
    }

    restart() {
        return this._exclusive(async () => {
            if (this.destroyed) throw new Error("O runtime foi destruído");
            this.retries += 1;
            this.transition(RuntimeState.RECOVERING, "Reconectando Tor e sessão");
            await this._stopResources();
            return this._start(true);
        });
    }

    async stop() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = null;
        const activeTor = this.tor;
        this.tor = null;
        try { activeTor?.stop(); } catch (error) { this.dependencies.onCleanupError?.(error); }
        if (this.operation) await this.operation.catch(() => {});
        return this._exclusive(async () => {
            await this._stopResources();
            if (this.state !== RuntimeState.STOPPED) {
                this.transition(RuntimeState.STOPPED, "Perfil parado");
            }
        });
    }

    runOperation(task) {
        if (this.destroyed) return Promise.reject(new Error("O runtime foi destruído"));
        return this._exclusive(() => task(this));
    }

    reportRoute({ reachable, isTor }) {
        if (!reachable && this.state === RuntimeState.READY) {
            return this.transition(RuntimeState.ROUTE_FAILED, "A rota Chromium não respondeu");
        }
        if (reachable && isTor === false && this.state === RuntimeState.READY) {
            return this.transition(RuntimeState.LEAK_DETECTED, "A rota Chromium não foi reconhecida como Tor");
        }
        if (reachable && isTor === true
            && (this.state === RuntimeState.ROUTE_FAILED || this.state === RuntimeState.LEAK_DETECTED)) {
            return this.transition(RuntimeState.READY, "Rota Chromium confirmada pela rede Tor");
        }
        return this.snapshot();
    }

    async destroy() {
        this.destroyed = true;
        if (this.operation) await this.operation.catch(() => {});
        await this.stop();
    }

    async _start(recovering) {
        if (this.destroyed) throw new Error("O runtime foi destruído");
        if (this.state === RuntimeState.READY) return this;
        this.transition(recovering ? RuntimeState.BOOTSTRAPPING : RuntimeState.STARTING,
            recovering ? "Reiniciando Tor" : "Iniciando Tor");
        if (!recovering) this.transition(RuntimeState.BOOTSTRAPPING, "Aguardando bootstrap do Tor");

        try {
            const handle = this.dependencies.launchTor(this.profile, {
                onBootstrap: percent => this.dependencies.onBootstrap?.(this.profile.id, percent),
                onExit: (code, wasBootstrapped) => this._handleTorExit(code, wasBootstrapped)
            });
            this.tor = handle;
            await handle.ready;
        } catch (error) {
            await this._stopResources();
            this.transition(RuntimeState.TOR_FAILED, error.message);
            throw error;
        }

        try {
            this.session = await this.dependencies.createSession(this.profile);
        } catch (error) {
            await this._stopResources();
            this.transition(RuntimeState.PROXY_FAILED, `Falha ao configurar proxy: ${error.message}`);
            throw error;
        }

        this.retries = Math.max(0, this.retries - (recovering ? 1 : 0));
        this.transition(RuntimeState.READY, recovering ? "Tor recuperado com sucesso" : "Sessão ativa e pronta");
        this._startHealthMonitor();
        return this;
    }

    _exclusive(task) {
        if (this.operation) return this.operation;
        const operation = Promise.resolve().then(task);
        const wrapped = operation.finally(() => {
            if (this.operation === wrapped) this.operation = null;
        });
        this.operation = wrapped;
        return wrapped;
    }

    _startHealthMonitor() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = setInterval(() => void this._checkHealth(), this.dependencies.healthIntervalMs);
    }

    async _checkHealth() {
        if (this.healthCheckRunning || this.destroyed || this.state === RuntimeState.STOPPED) return;
        this.healthCheckRunning = true;
        try {
            const processRunning = this.tor?.process?.exitCode === null && !this.tor.process.killed;
            if (!processRunning) {
                if (this.state !== RuntimeState.DEGRADED) {
                    this.transition(RuntimeState.DEGRADED, "Tor fora do ar. Tentando recuperar...");
                }
                await this.restart();
                return;
            }
            const controlAvailable = await this.dependencies.checkControlPort(this.profile.controlPort);
            if (!controlAvailable && this.state === RuntimeState.READY) {
                this.transition(RuntimeState.DEGRADED, "ControlPort indisponível");
            } else if (controlAvailable && this.state === RuntimeState.DEGRADED) {
                this.transition(RuntimeState.READY, "Tor saudável e pronto");
            }
        } catch (error) {
            if (!this.destroyed && this.state !== RuntimeState.ERROR) {
                this.transition(RuntimeState.ERROR, error.message || "Falha no monitor de saúde");
            }
        } finally {
            this.healthCheckRunning = false;
        }
    }

    async _stopResources() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = null;
        const tor = this.tor;
        this.tor = null;
        try { tor?.stop(); } catch (error) { this.dependencies.onCleanupError?.(error); }
        const currentSession = this.session;
        this.session = null;
        if (currentSession) {
            try { await currentSession.closeAllConnections(); }
            catch (error) { this.dependencies.onCleanupError?.(error); }
        }
    }

    _handleTorExit(code, wasBootstrapped) {
        if (this.destroyed || this.state === RuntimeState.STOPPED || this.state === RuntimeState.RECOVERING) return;
        if (wasBootstrapped && this.state === RuntimeState.READY) {
            this.transition(RuntimeState.DEGRADED, `Instância Tor encerrou (code=${code})`);
        }
    }
}

module.exports = { ProfileRuntime };
