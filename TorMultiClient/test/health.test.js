const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { isCompleteReply, parseTorStatus, queryTorStatus } = require("../lib/tor-control");
const { parseIpResponse } = require("../lib/socks-health");

test("detecta uma resposta completa do ControlPort", () => {
    assert.equal(isCompleteReply("250-status/circuit-established=1\r\n250 OK\r\n"), true);
    assert.equal(isCompleteReply("250-status/circuit-established=1\r\n"), false);
});

test("interpreta bootstrap e circuito do Tor", () => {
    const result = parseTorStatus([
        "250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=Done\r\n250 OK\r\n",
        "250-status/circuit-established=1\r\n250 OK\r\n"
    ]);
    assert.deepEqual(result, {
        bootstrapProgress: 100,
        bootstrapped: true,
        circuitEstablished: true
    });
});

test("valida respostas IPv4 e IPv6", () => {
    assert.equal(parseIpResponse('{"ip":"198.51.100.8"}'), "198.51.100.8");
    assert.equal(parseIpResponse('{"ip":"2001:db8::8"}'), "2001:db8::8");
    assert.throws(() => parseIpResponse('{"ip":"não-é-ip"}'));
});

test("autentica com cookie hexadecimal e consulta o estado", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tor-health-test-"));
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir);
    const cookie = Buffer.alloc(32, 0xab);
    fs.writeFileSync(path.join(dataDir, "control_auth_cookie"), cookie);
    const commands = [];

    const server = net.createServer(socket => {
        let buffer = "";
        socket.on("data", chunk => {
            buffer += chunk.toString("utf8");
            while (buffer.includes("\r\n")) {
                const index = buffer.indexOf("\r\n");
                const command = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                commands.push(command);

                if (command.startsWith("AUTHENTICATE ")) socket.write("250 OK\r\n");
                else if (command.includes("bootstrap-phase")) {
                    socket.write("250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=Done\r\n250 OK\r\n");
                } else if (command.includes("circuit-established")) {
                    socket.write("250-status/circuit-established=1\r\n250 OK\r\n");
                }
            }
        });
    });

    try {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const result = await queryTorStatus({
            controlPort: server.address().port,
            torrcFile: path.join(tempDir, "torrc")
        });
        assert.equal(result.bootstrapped, true);
        assert.equal(result.circuitEstablished, true);
        assert.equal(commands[0], `AUTHENTICATE ${cookie.toString("hex")}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
