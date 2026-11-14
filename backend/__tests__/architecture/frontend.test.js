import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("dashboard modules link, assemble once and preserve shared state across features", async () => {
  const context = vm.createContext({
    console, URL, Headers, Map, Set, Date, Math, JSON, Intl, Promise,
    crypto: { randomUUID: () => "test-client" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { location: { origin: "http://localhost", hash: "" } },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  const cache = new Map();
  async function moduleFor(file) {
    file = file.split("?")[0].replaceAll("\\", "/");
    if (cache.has(file)) return cache.get(file);
    let module;
    if (file.endsWith("/auth-session.js")) {
      module = new vm.SyntheticModule(["currentUser", "apiFetch", "requireLogin", "bindAccountControls"], function () {
        this.setExport("currentUser", { id: 7, username: "test", role: "EMPLEADO" });
        this.setExport("apiFetch", async () => { throw Error("Unexpected HTTP request"); });
        this.setExport("requireLogin", async () => ({ id: 7 }));
        this.setExport("bindAccountControls", () => {});
      }, { context, identifier: file });
    } else if (file.endsWith("/realtime/socket.js")) {
      module = new vm.SyntheticModule(["socket", "API_BASE"], function () {
        this.setExport("socket", { connected: false, on() {}, emit() {} });
        this.setExport("API_BASE", "http://localhost");
      }, { context, identifier: file });
    } else {
      module = new vm.SourceTextModule(await readFile(file, "utf8"), { context, identifier: file });
    }
    cache.set(file, module);
    return module;
  }
  const module = await moduleFor(path.join(root, "frontend/app/dashboard.js"));
  await module.link((specifier, referencing) => moduleFor(path.resolve(path.dirname(referencing.identifier), specifier)));
  await module.evaluate();
  const app = module.namespace.createDashboardApp();
  assert.equal(app.state.sessionCode, "");
  assert.equal(app.state.dashboardClientId, "test-client");
  assert.equal(app.actions.normalizeValidPeruPhone("+51 987 654 321"), "987654321");
  assert.equal(app.actions.normalizeImportedPhone("987 654 321"), "987654321");
  assert.equal(app.actions.normalizeValidPeruPhone("invalid"), "");
  assert.equal(app.actions.formatCallDuration(65), "01:05");
  assert.equal(app.actions.getSavedSessionCode(), "");
  app.state.callHistory = [{ phone: "987654321" }];
  assert.equal(app.state.callHistory.length, 1);
  assert.equal(typeof app.actions.renderContacts, "function");
  assert.equal(typeof app.actions.loadPairingData, "function");
  assert.equal(typeof app.actions.startCampaignRun, "function");
  const second = module.namespace.createDashboardApp();
  assert.equal(second.state.callHistory.length, 0, "different instances cannot share mutable state");
});

test("all relative imports, dynamic imports and public HTML resources resolve after the move", async () => {
  const { readdir } = await import("node:fs/promises");
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(file));
      else files.push(file);
    }
    return files;
  }
  for (const area of ["backend", "frontend", "shared"]) {
    for (const file of await walk(path.join(root, area))) {
      if (!/\.(?:js|mjs|html|css)$/.test(file)) continue;
      const source = await readFile(file, "utf8");
      const specifiers = file.endsWith(".html")
        ? [...source.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1])
        : file.endsWith(".css")
          ? [...source.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1])
          : [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)].map(match => match[1]);
      for (const original of specifiers) {
        const specifier = original.split(/[?#]/)[0];
        if (!specifier || /^(?:https?:|data:)/.test(specifier)) continue;
        if (specifier.startsWith("/api/") || specifier.startsWith("/socket.io/")) continue;
        if (file.endsWith(".html") && !/\.(?:js|css|png|ico|svg|jpg|webp)$/.test(specifier)) continue;
        const publicPath = file.endsWith(".html") && specifier.startsWith("/");
        if (!publicPath && !specifier.startsWith(".")) continue;
        const candidates = publicPath
          ? [path.join(root, "frontend", specifier), path.join(root, "web", specifier), path.join(root, specifier)]
          : [path.resolve(path.dirname(file), specifier)];
        const exists = await Promise.all(candidates.map(candidate => stat(candidate).then(value => value.isFile()).catch(() => false)));
        assert.ok(exists.some(Boolean), file + " → " + original);
      }
    }
  }
});

// The stylesheet was split without reordering overrides or changing declarations.
test("stylesheet chunks preserve the original cascade byte for byte", async () => {
  const entry = path.join(root, "frontend/shared/styles/base.css");
  const sheet = await readFile(entry, "utf8");
  const imports = [...sheet.matchAll(/@import url\("([^"]+)"\);/g)].map(match => match[1]);
  assert.equal(imports.length, 23);
  const parts = await Promise.all(imports.map(file => readFile(path.resolve(path.dirname(entry), file), "utf8")));
  let hash = 2166136261;
  const reconstructed = parts.join("").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  for (const character of reconstructed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const contracts = JSON.parse(await readFile(path.join(root, "docs/architecture/contracts.json"), "utf8"));
  assert.equal(hash, contracts.styleHash);
});
