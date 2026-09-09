const fs = require("fs");
const net = require("net");

function isCompleteReply(buffer) {
    const lines = buffer.split("\r\n").filter(Boolean);
    return lines.length > 0 && /^\d{3} /.test(lines.at(-1));
}

function replyCode(reply) {
    const match = reply.match(/^(\d{3})[ -]/);
    return match ? Number(match[1]) : 0;
}

function parseTorStatus(replies) {
    const text = replies.join("\n");
    const progressMatch = text.match(/PROGRESS=(\d+)/);
    const circuitMatch = text.match(/status\/circuit-established=(\d)/);
    const bootstrapProgress = progressMatch ? Number(progressMatch[1]) : 0;

    return {
        bootstrapProgress,
        bootstrapped: bootstrapProgress === 100,
        circuitEstablished: circuitMatch ? circuitMatch[1] === "1" : false
    };
}

function sendControlCommands({ port, cookieFile, commands, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(cookieFile)) {
            reject(new Error("Cookie de autenticação do Tor não encontrado"));
            return;
        }

        const cookieHex = fs.readFileSync(cookieFile).toString("hex");
        // Hexadecimal cookie authentication must be sent unquoted. Inside quotes,
        // Tor interprets the 64 hex characters as 64 raw bytes instead of 32.
        const queue = [`AUTHENTICATE ${cookieHex}`, ...commands];
        const replies = [];
        let buffer = "";
        let settled = false;

        const socket = net.createConnection({ host: "127.0.0.1", port });

        function finish(error, result) {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) reject(error);
            else resolve(result);
        }

        function sendNext() {
            const command = queue.shift();
            if (!command) {
                finish(null, replies);
                return;
            }
            socket.write(`${command}\r\n`);
        }

        socket.on("connect", sendNext);
        socket.on("data", chunk => {
            buffer += chunk.toString("utf8");
            if (!isCompleteReply(buffer)) return;

            const reply = buffer;
            buffer = "";
            const code = replyCode(reply);
            if (code !== 250) {
                finish(new Error(`ControlPort recusou o comando (${code || "resposta inválida"})`));
                return;
            }

            replies.push(reply);
            sendNext();
        });
        socket.on("error", error => finish(error));
        socket.on("end", () => {
            if (!settled) finish(new Error("ControlPort encerrou a conexão antes da resposta"));
        });
        socket.setTimeout(timeoutMs, () => finish(new Error("Timeout ao consultar ControlPort")));
    });
}

async function queryTorStatus(account, timeoutMs = 5000) {
    const cookieFile = require("path").join(
        require("path").dirname(account.torrcFile),
        "data",
        "control_auth_cookie"
    );
    const replies = await sendControlCommands({
        port: account.controlPort,
        cookieFile,
        timeoutMs,
        commands: [
            "GETINFO status/bootstrap-phase",
            "GETINFO status/circuit-established"
        ]
    });
    return parseTorStatus(replies);
}

async function signalNewIdentity(account, timeoutMs = 5000) {
    const path = require("path");
    const cookieFile = path.join(path.dirname(account.torrcFile), "data", "control_auth_cookie");
    await sendControlCommands({
        port: account.controlPort,
        cookieFile,
        timeoutMs,
        commands: ["SIGNAL NEWNYM"]
    });
}

module.exports = {
    isCompleteReply,
    parseTorStatus,
    queryTorStatus,
    sendControlCommands,
    signalNewIdentity
};
