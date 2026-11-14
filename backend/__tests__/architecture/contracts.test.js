import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../create-runtime.js";
import { registerSockets } from "../../sockets/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const contracts = JSON.parse(await readFile(path.join(root, "docs/architecture/contracts.json"), "utf8"));

test("HTTP contracts, authentication, shared assets and Android pairing remain compatible", async t => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    APP_ENV: "easypanel", PUBLIC_BASE_URL: "https://calls.example.test",
    DB_HOST: "mysql", DB_PORT: "3306", DB_NAME: "architecture_test",
    DB_USER: "architecture_test", DB_PASSWORD: "synthetic-test-password"
  });
  delete process.env.AUTH_LOCAL_ISOLATED;
  const { runtime, services } = createRuntime(root);
  t.after(async () => {
    await new Promise(resolve => runtime.io.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  const registered = new Set(runtime.app._router.stack.flatMap(layer => {
    if (!layer.route) return [];
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    return paths.flatMap(route => Object.keys(layer.route.methods).map(method => method.toUpperCase() + " " + route));
  }));
  for (const route of contracts.http) assert.ok(registered.has(route.method + " " + route.path), "Missing route: " + JSON.stringify(route));

  await new Promise(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + runtime.server.address().port;
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/api/session/ABC123/workers")).status, 401);
  assert.equal((await fetch(base + "/api/network")).status, 401);
  for (const resource of [
    "/login", "/features/auth/login-page.js", "/app/dashboard.js",
    "/layouts/dashboard/sidebar.js", "/shared/styles/base.css",
    "/shared/reports/report-metrics.js", "/shared/assets/images/logo-vc-color.png"
  ]) assert.equal((await fetch(base + resource)).status, 200, resource);

  const response = await fetch(base + "/api/android/pair", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /code, token y deviceId/);

  // Pairing is intentionally outside dashboard cookie authentication.
  const session = services.normalizeSessionShape();
  runtime.sessions.set("ABC123", session);
  const slot = session.pairingSlots[0];
  runtime.persistence.save = async () => ({ committed: true });
  const paired = await fetch(base + "/api/android/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ABC123", token: slot.token, deviceId: "test-phone", deviceName: "Android test" })
  });
  assert.equal(paired.status, 200);
  const data = await paired.json();
  assert.equal(data.socket.role, "phone");
  assert.equal(data.socket.token, slot.token);
  assert.equal(data.workers[0].id, "test-phone");
});

test("all pre-migration socket events are registered exactly once per connection", () => {
  let connected;
  registerSockets({ io: { on: (event, handler) => { assert.equal(event, "connection"); connected = handler; } } }, {});
  const events = [];
  connected({ on: name => events.push(name) });
  assert.deepEqual([...events].sort(), [...contracts.socketEvents].sort());
  assert.equal(new Set(events).size, events.length);
});
