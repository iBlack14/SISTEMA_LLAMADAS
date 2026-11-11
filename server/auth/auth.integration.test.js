import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import mysql from "mysql2/promise";
import { createRequire } from "node:module";
import { localConfig, appEnvironment, verifyDatabase, projectRoot } from "./local-runtime.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { assertIsolatedConfig, assertXamppConfig } from "./config.js";
// Use the WebSocket implementation already supplied by Socket.IO's transport.
const require = createRequire(import.meta.url);
const transportRequire = createRequire(require.resolve("engine.io"));
const WebSocket = transportRequire("ws");

// A minimal Socket.IO/Engine.IO protocol client avoids running any phone commands.
class Client {
  constructor(cookie = "", origin = "http://127.0.0.1:3102", handshakeAuth = {}) {
    this.events = [];
    this.ws = new WebSocket("ws://127.0.0.1:3102/socket.io/?EIO=4&transport=websocket", {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }
    });
    this.ws.on("message", raw => {
      const message = String(raw);
      if (message.startsWith("0")) this.ws.send(`40${JSON.stringify(handshakeAuth)}`);
      else if (message.startsWith("40")) this.ready = true;
      else if (message === "2") this.ws.send("3");
      else if (message.startsWith("42")) {
        const [name, data] = JSON.parse(message.slice(2));
        this.events.push({ name, data });
      } else if (message.startsWith("43")) {
        this.events.push({ name: "ack", data: JSON.parse(message.slice(message.indexOf("[")))[0] });
      } else if (message.startsWith("44")) {
        this.events.push({ name: "connect:error", data: JSON.parse(message.slice(2)) });
      }
    });
    this.ws.on("error", () => {});
  }
  async connected() {
    for (let i = 0; i < 100; i++) { if (this.ready) return this; await delay(25); }
    throw new Error("Socket connection timeout");
  }
  send(name, data) { this.ws.send(`42${JSON.stringify([name, data])}`); }
  sendWithAck(name) { this.ws.send(`421${JSON.stringify([name])}`); }
  async event(name) {
    for (let i = 0; i < 160; i++) {
      const index = this.events.findIndex(event => event.name === name);
      if (index >= 0) return this.events.splice(index, 1)[0].data;
      await delay(25);
    }
    throw new Error(`Timeout waiting for ${name}`);
  }
  close() { this.ws.terminate(); }
}

test("password hashing and database configuration reject unsafe inputs", async () => {
  const hash = await hashPassword("synthetic-password-only");
  assert.equal(await verifyPassword("synthetic-password-only", hash), true);
  assert.equal(await verifyPassword("incorrect", hash), false);
  assert.notEqual(hash, await hashPassword("synthetic-password-only"));
  assert.throws(() => assertIsolatedConfig({ AUTH_LOCAL_ISOLATED: "1", DB_HOST: "remote", DB_NAME: "production" }));
  assert.doesNotThrow(() => assertXamppConfig({ DB_HOST: "localhost", DB_NAME: "calls", DB_USER: "root" }));
  assert.throws(() => assertXamppConfig({ DB_HOST: "remote", DB_PORT: "3306", DB_NAME: "calls", DB_USER: "root" }));
  assert.throws(() => assertXamppConfig({ DB_HOST: "localhost", DB_PORT: "3308", DB_NAME: "calls", DB_USER: "root" }));
});

test("HTTP and Socket.IO enforce roles, explicit grants, revocation and Android pairing", { timeout: 180000 }, async t => {
  const config = await localConfig();
  const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user,
    password: config.password, database: config.database, timezone: "Z" });
  await verifyDatabase(db);
  const suffix = randomBytes(5).toString("hex");
  const password = randomBytes(20).toString("hex");
  const users = [];
  const clients = [];
  const codes = new Set();
  const base = "http://127.0.0.1:3102";
  let output = "";
  const app = spawn(process.execPath, ["server/server.js"], { cwd: projectRoot, windowsHide: true,
    env: { ...appEnvironment(config), PORT: "3102", PUBLIC_BASE_URL: base, PUBLIC_WEB_BASE_URL: base, CORS_ORIGIN: base },
    stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", data => { output += data; });
  app.stderr.on("data", data => { output += data; });
  const request = (url, account, options = {}) => fetch(base + url, { redirect: "manual", ...options,
    headers: { Origin: base, ...(account ? { Cookie: account.cookie, "X-CSRF-Token": account.csrfToken } : {}), ...options.headers } });
  async function login(username, suppliedPassword = password) {
    const response = await request("/api/auth/login", null, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: suppliedPassword }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);
    const me = await (await request("/api/auth/me", { cookie })).json();
    return { cookie, ...me };
  }
  async function connect(account) {
    const client = new Client(account?.cookie);
    clients.push(client);
    return client.connected();
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (app.exitCode !== null) throw new Error(`Server failed: ${output}`);
      try { if ((await request("/health")).ok) break; } catch {}
      if (i === 119) throw new Error(`Server startup timeout: ${output}`);
      await delay(100);
    }
    for (const role of ["EMPLEADO", "ADMINISTRADOR", "EMPLEADO"]) {
      const username = `auth-test-${suffix}-${users.length}`;
      const [result] = await db.query("INSERT INTO auth_users(username,password_hash,role) VALUES (?,?,?)", [username, await hashPassword(password), role]);
      users.push({ id: result.insertId, username, role });
    }
    const employee = await login(users[0].username);
    const admin = await login(users[1].username);
    const outsider = await login(users[2].username);
    let operational;
    let employeeSocket;
    let phoneReconnect;
    await t.test("the browser handshake requires its cookie, origin and expected account", async () => {
      const missing = new Client("", base, { client: "dashboard" });
      clients.push(missing);
      assert.equal((await missing.event("connect:error")).message, "AUTH_REQUIRED");
      const badOrigin = new Client(employee.cookie, "http://untrusted.example", { client: "dashboard" });
      clients.push(badOrigin);
      assert.equal((await badOrigin.event("connect:error")).message, "AUTH_ORIGIN");
      const changed = new Client(employee.cookie, base, { client: "dashboard", userId: users[1].id });
      clients.push(changed);
      assert.equal((await changed.event("connect:error")).message, "AUTH_CHANGED");
    });
    await t.test("anonymous HTTP, incorrect login, cookies, CSRF and administrative routes", async () => {
      assert.equal((await request("/")).status, 302);
      assert.equal((await request("/api/auth/me")).status, 401);
      assert.equal((await request("/admin/nucleo-red")).status, 302);
      assert.equal((await request("/", employee)).status, 200);
      assert.equal((await request("/admin/nucleo-red", employee)).status, 403);
      assert.equal((await request("/admin.html", employee)).status, 403);
      assert.equal((await request("/ADMIN.HTML", employee)).status, 403);
      assert.equal((await request("/api/admin/network/access", employee)).status, 403);
      assert.equal((await request("/api/admin/network", employee)).status, 403);
      assert.equal((await request("/api/admin/network/equipment/1", employee)).status, 403);
      assert.equal((await request("/api/admin/network/activity?equipment=1,2", employee)).status, 403);
      assert.equal((await request("/admin/nucleo-red", admin)).status, 200);
      assert.equal((await request("/api/admin/network/access", admin)).status, 200);
      const network = await (await request("/api/admin/network", admin)).json();
      assert.equal(network.equipment.length, 10);
      assert.ok(network.equipment.every(item => !("activity" in item)));
      const batch = await (await request("/api/admin/network/activity?equipment=1,2", admin)).json();
      assert.deepEqual(batch.equipment.map(item => item.number), [1, 2]);
      assert.ok(batch.equipment.every(item => Array.isArray(item.activity)));
      assert.equal((await request("/api/admin/network/activity?equipment=11", admin)).status, 400);
      assert.equal((await request("/api/auth/login", null, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: users[0].username, password: "wrong" }) })).status, 401);
      assert.equal((await request("/api/auth/logout", employee, { method: "POST", headers: { "X-CSRF-Token": "" } })).status, 403);
      assert.equal((await request("/api/auth/logout", employee, { method: "POST", headers: { Origin: "http://untrusted.example" } })).status, 403);
    });
    await t.test("anonymous sockets cannot create sessions; employees cannot subscribe as admin", async () => {
      const anonymous = await connect();
      anonymous.send("session:create", {});
      assert.equal((await anonymous.event("session:error")).reason, "AUTH_REQUIRED");
      employeeSocket = await connect(employee);
      employeeSocket.send("admin:subscribe", {});
      assert.equal((await employeeSocket.event("session:error")).reason, "FORBIDDEN");
      assert.equal(employeeSocket.events.some(event => event.name === "admin:network"), false);
      employeeSocket.send("session:create", { dashboardClientId: `test-${suffix}` });
      operational = await employeeSocket.event("session:created");
      codes.add(operational.code);
      assert.ok(operational.dashboardToken);
      const [[grant]] = await db.query("SELECT COUNT(*) AS count FROM auth_session_access WHERE user_id=? AND session_code=?", [users[0].id, operational.code]);
      assert.equal(grant.count, 1);
      const adminSocket = await connect(admin);
      adminSocket.sendWithAck("admin:subscribe");
      assert.equal((await adminSocket.event("ack")).ok, true);
      assert.equal((await adminSocket.event("admin:network")).equipment.length, 10);
    });
    const operationalRequest = (path, account = employee, options = {}) => request(`/api/session/${operational.code}${path}`, account,
      { ...options, headers: { "X-Dashboard-Token": operational.dashboardToken, ...options.headers } });
    await t.test("a stolen operational token alone never grants access over HTTP or sockets", async () => {
      assert.equal((await operationalRequest("/workers", null)).status, 401);
      assert.equal((await operationalRequest("/workers", outsider)).status, 403);
      assert.equal((await operationalRequest("/workers", admin)).status, 403);
      assert.equal((await operationalRequest("/workers")).status, 200);
      const otherSocket = await connect(outsider);
      otherSocket.send("session:join", { code: operational.code, token: operational.dashboardToken, role: "dashboard" });
      assert.equal((await otherSocket.event("session:error")).reason, "SESSION_FORBIDDEN");
      const put = await operationalRequest("/contact-book", employee, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, book: { lists: ["Prueba aislada"], contacts: [], preferences: {} } }) });
      assert.equal(put.status, 200);
      assert.equal((await operationalRequest("/campaign/pause", employee, { method: "POST", headers: { "X-CSRF-Token": "" } })).status, 403);
    });
    await t.test("QR and Android pairing retain device authentication and rotation", async () => {
      assert.equal((await request(`/api/pairing/${operational.code}`, outsider, { headers: { "X-Dashboard-Token": operational.dashboardToken } })).status, 403);
      const response = await request(`/api/pairing/${operational.code}`, employee, { headers: { "X-Dashboard-Token": operational.dashboardToken } });
      assert.equal(response.status, 200);
      const data = await response.json();
      const slot = data.pairingSlots[0];
      const token = new URL(slot.link).searchParams.get("token");
      const qr = await request(`/api/pairing-qr/${operational.code}.svg?slot=${slot.id}`, employee, { headers: { "X-Dashboard-Token": operational.dashboardToken } });
      assert.equal(qr.status, 200);
      assert.match(await qr.text(), /<svg/);
      const pairBody = { code: operational.code, token, deviceId: `android-test-${suffix}`, deviceName: "Android sintético" };
      assert.equal((await request("/api/android/pair", null, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pairBody, token: "wrong" }) })).status, 401);
      assert.equal((await request("/api/android/pair", null, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pairBody) })).status, 200);
      const phone = await connect();
      phone.send("session:join", { ...pairBody, role: "phone" });
      const joined = await phone.event("session:joined");
      assert.equal(joined.role, "phone");
      assert.ok(joined.token && joined.token !== token);
      phone.send("admin:subscribe", {});
      assert.equal((await phone.event("session:error")).reason, "AUTH_REQUIRED");
      phone.send("session:create", {});
      assert.equal((await phone.event("session:error")).reason, "AUTH_REQUIRED");
      phone.close();
      const reconnect = await connect();
      phoneReconnect = reconnect;
      reconnect.send("session:join", { ...pairBody, token: joined.token, role: "phone" });
      const rejoined = await reconnect.event("session:joined");
      assert.equal(rejoined.role, "phone");
      const deviceSnapshot = async () => {
        const result = await (await request("/api/admin/network", admin)).json();
        return result.equipment.find(item => item.deviceId === pairBody.deviceId);
      };
      assert.equal((await deviceSnapshot()).calling, false, "pairing alone cannot pulse");
      for (const [state, expected, calling] of [["dialing", "Marcando", true], ["in_call", "En llamada", true], ["ended", "Disponible", false]]) {
        reconnect.send("phone:status", { callState: state });
        await reconnect.event("phone:status_ack");
        const observed = await deviceSnapshot();
        assert.equal(observed.state, expected);
        assert.equal(observed.calling, calling);
        assert.equal(observed.simulated, true);
        assert.equal((await deviceSnapshot()).state, expected, "reload/API must recover current state");
        if (state === "in_call" && process.env.NETWORK_PREVIEW_MS) {
          console.log("Vista de prueba simulada disponible temporalmente en http://127.0.0.1:3102/admin/nucleo-red");
          await delay(Math.min(60000, Math.max(0, Number(process.env.NETWORK_PREVIEW_MS) || 0)));
        }
      }
      const wrongDevice = await connect();
      wrongDevice.send("session:join", { ...pairBody, token: rejoined.token, deviceId: "different-device", role: "phone" });
      assert.match((await wrongDevice.event("session:error")).message, /otro telefono/);
      reconnect.send("phone:status", { callState: "in_call" });
      await reconnect.event("phone:status_ack");
      assert.equal((await deviceSnapshot()).calling, true);
      reconnect.close();
      await delay(100);
      assert.equal((await deviceSnapshot()).calling, false);
      assert.equal((await deviceSnapshot()).state, "Desconectado");
      phoneReconnect = await connect();
      phoneReconnect.send("session:join", { ...pairBody, token: rejoined.token, role: "phone" });
      await phoneReconnect.event("session:joined");
      assert.equal((await deviceSnapshot()).calling, false, "reconnection needs fresh Android evidence");
    });
    await t.test("revoked sessions reject new HTTP requests and already connected sockets", async () => {
      assert.equal((await request("/api/auth/logout", employee, { method: "POST" })).status, 200);
      assert.equal((await operationalRequest("/workers")).status, 401);
      await delay(150);
      assert.notEqual(employeeSocket.ws.readyState, WebSocket.OPEN);
      assert.equal(phoneReconnect.ws.readyState, WebSocket.OPEN);
      const disabled = await connect(outsider);
      await db.query("UPDATE auth_users SET active=0 WHERE id=?", [users[2].id]);
      disabled.send("session:create", {});
      assert.equal((await disabled.event("session:error")).reason, "AUTH_REQUIRED");
      assert.equal((await request("/api/auth/me", outsider)).status, 401);
      await db.query("UPDATE auth_sessions SET last_seen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 31 MINUTE) WHERE user_id=?", [users[1].id]);
      assert.equal((await request("/api/auth/me", admin)).status, 401);
    });
    await t.test("a removed explicit grant stops a passive browser socket receiving session data", async () => {
      const fresh = await login(users[0].username);
      const passive = await connect(fresh);
      passive.send("session:join", { code: operational.code, role: "dashboard", token: operational.dashboardToken, dashboardClientId: `test-${suffix}` });
      await passive.event("session:joined");
      await db.query("DELETE FROM auth_session_access WHERE user_id=? AND session_code=?", [users[0].id, operational.code]);
      assert.equal((await operationalRequest("/workers", fresh)).status, 403);
      for (let i = 0; i < 65 && passive.ws.readyState === WebSocket.OPEN; i++) await delay(100);
      assert.notEqual(passive.ws.readyState, WebSocket.OPEN);
    });
  } finally {
    for (const client of clients) client.close();
    app.kill();
    await new Promise(resolve => { if (app.exitCode !== null) resolve(); else app.once("exit", resolve); });
    for (const code of codes) {
      await db.query("DELETE FROM admin_network_devices WHERE session_code=?", [code]);
      for (const table of ["vc_call_attempts", "vc_call_contacts", "vc_call_devices", "vc_call_campaigns", "vc_call_turns"]) {
        await db.query(`DELETE FROM ${table} WHERE session_code=?`, [code]);
      }
      await db.query("DELETE FROM sessions WHERE id=?", [code]);
    }
    for (const user of users) {
      await db.query("DELETE FROM auth_session_access WHERE user_id=?", [user.id]);
      await db.query("DELETE FROM auth_sessions WHERE user_id=?", [user.id]);
      await db.query("DELETE FROM auth_users WHERE id=?", [user.id]);
    }
    await db.end();
  }
});
