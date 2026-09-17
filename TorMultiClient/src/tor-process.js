const path = require("path");
const { spawn } = require("child_process");

function launchTorProcess(profile, options) {
    const {
        torExecutable,
        bootstrapTimeoutMs = 90_000,
        spawnProcess = spawn,
        onBootstrap = () => {},
        onOutput = () => {},
        onExit = () => {}
    } = options;

    const child = spawnProcess(torExecutable, ["-f", profile.torrcFile], {
        cwd: path.dirname(profile.torrcFile),
        stdio: ["ignore", "pipe", "pipe"]
    });

    let readySettled = false;
    let bootstrapped = false;
    let timeout;
    let stopped = false;
    let handleOutput;
    let handleError;
    let handleExit;
    let rejectReady;

    const removeListeners = () => {
        child.stdout.removeListener("data", handleOutput);
        child.stderr.removeListener("data", handleOutput);
        child.removeListener("error", handleError);
        child.removeListener("exit", handleExit);
    };

    const ready = new Promise((resolve, reject) => {
        rejectReady = reject;
        const fail = error => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(timeout);
            removeListeners();
            try {
                if (child.exitCode === null && !child.killed) child.kill();
            } catch (killError) {
                options.onCleanupError?.(killError);
            }
            reject(error);
        };

        handleOutput = chunk => {
            const text = chunk.toString();
            onOutput(text);
            const match = text.match(/Bootstrapped (\d+)%/);
            if (match) {
                const percent = Number(match[1]);
                onBootstrap(percent);
                if (percent === 100 && !readySettled) {
                    bootstrapped = true;
                    readySettled = true;
                    clearTimeout(timeout);
                    resolve(child);
                }
            }
            if (!bootstrapped && (text.includes("[err]") || text.includes("[warn] Could not bind"))) {
                fail(new Error(`Tor ${profile.torPort}: ${text.trim()}`));
            }
        };

        handleError = error => fail(error);
        handleExit = code => {
            clearTimeout(timeout);
            removeListeners();
            if (!bootstrapped && !stopped) fail(new Error(`Tor encerrou antes do bootstrap (code=${code})`));
            onExit(code, bootstrapped);
        };

        child.stdout.on("data", handleOutput);
        child.stderr.on("data", handleOutput);
        child.once("error", handleError);
        child.once("exit", handleExit);

        timeout = setTimeout(() => {
            fail(new Error(`Timeout ao aguardar bootstrap do Tor ${profile.torPort}`));
        }, bootstrapTimeoutMs);
    });

    return {
        process: child,
        ready,
        stop() {
            if (stopped) return;
            stopped = true;
            clearTimeout(timeout);
            removeListeners();
            if (!readySettled) {
                readySettled = true;
                rejectReady(new Error("Inicialização do Tor interrompida"));
            }
            try {
                if (child.exitCode === null && !child.killed) child.kill();
            } catch (error) {
                options.onCleanupError?.(error);
            }
        }
    };
}

module.exports = { launchTorProcess };
