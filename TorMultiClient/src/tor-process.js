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

    const ready = new Promise((resolve, reject) => {
        const fail = error => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(timeout);
            try {
                if (child.exitCode === null && !child.killed) child.kill();
            } catch (_) {}
            reject(error);
        };

        const handleOutput = chunk => {
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

        child.stdout.on("data", handleOutput);
        child.stderr.on("data", handleOutput);
        child.once("error", fail);
        child.once("exit", code => {
            if (!bootstrapped) fail(new Error(`Tor encerrou antes do bootstrap (code=${code})`));
            onExit(code, bootstrapped);
        });

        timeout = setTimeout(() => {
            fail(new Error(`Timeout ao aguardar bootstrap do Tor ${profile.torPort}`));
        }, bootstrapTimeoutMs);
    });

    return {
        process: child,
        ready,
        stop() {
            clearTimeout(timeout);
            if (child.exitCode === null && !child.killed) child.kill();
        }
    };
}

module.exports = { launchTorProcess };
