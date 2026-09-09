const https = require("https");
const net = require("net");
const { SocksProxyAgent } = require("socks-proxy-agent");

function parseIpResponse(body) {
    const parsed = JSON.parse(body);
    if (!parsed.ip || net.isIP(parsed.ip) === 0) {
        throw new Error("O serviço de IP retornou uma resposta inválida");
    }
    return parsed.ip;
}

function checkIpViaSocks(port, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${port}`);
        let settled = false;

        function finish(error, value) {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        }

        const request = https.get("https://api.ipify.org/?format=json", {
            agent,
            headers: { "User-Agent": "TorMultiClient-health/0.2" }
        }, response => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", chunk => {
                body += chunk;
                if (body.length > 4096) {
                    request.destroy(new Error("Resposta do serviço de IP excedeu o limite"));
                }
            });
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    finish(new Error(`Serviço de IP respondeu HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    finish(null, parseIpResponse(body));
                } catch (error) {
                    finish(error);
                }
            });
        });

        request.on("error", error => finish(error));
        request.setTimeout(timeoutMs, () => request.destroy(new Error("Timeout no teste SOCKS5")));
    });
}

module.exports = { checkIpViaSocks, parseIpResponse };
