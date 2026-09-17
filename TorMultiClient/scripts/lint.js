const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const roots = ["main.js", "preload.js", "renderer.js", "src", "test", "scripts"];
const files = [];

function collect(target) {
    const absolute = path.join(projectRoot, target);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
        if (absolute.endsWith(".js")) files.push(absolute);
        return;
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        collect(path.relative(projectRoot, path.join(absolute, entry.name)));
    }
}

for (const root of roots) collect(root);
for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax lint passed for ${files.length} JavaScript files.`);
