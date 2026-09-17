const fs = require("fs");
const path = require("path");

function buildTorrc({ torPort, controlPort, dataDir, torExecutable }) {
    const geoipBaseDir = path.dirname(torExecutable);
    const geoipFiles = [
        { key: "GeoIPFile", file: path.join(geoipBaseDir, "geoip") },
        { key: "GeoIPv6File", file: path.join(geoipBaseDir, "geoip6") }
    ].filter(item => fs.existsSync(item.file));

    return [
        `SocksPort 127.0.0.1:${torPort} IsolateClientAddr IsolateSOCKSAuth`,
        `DataDirectory ${dataDir}`,
        "",
        "Log notice stdout",
        "",
        "MaxCircuitDirtiness 60",
        "NewCircuitPeriod 30",
        "",
        "TestSocks 1",
        "SafeSocks 1",
        "",
        ...geoipFiles.map(item => `${item.key} ${item.file}`),
        "",
        `ControlPort 127.0.0.1:${controlPort}`,
        "CookieAuthentication 1",
        ""
    ].join("\n");
}

module.exports = { buildTorrc };
