const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildTorrc } = require("../src/tor-config");

test("generates isolated loopback SOCKS and ControlPort settings", () => {
    const text = buildTorrc({
        torPort: 9100,
        controlPort: 9101,
        dataDir: path.join("tmp", "profile-1"),
        torExecutable: path.join("missing", "tor.exe")
    });

    assert.match(text, /SocksPort 127\.0\.0\.1:9100 IsolateClientAddr IsolateSOCKSAuth/);
    assert.match(text, /ControlPort 127\.0\.0\.1:9101/);
    assert.match(text, /CookieAuthentication 1/);
});
