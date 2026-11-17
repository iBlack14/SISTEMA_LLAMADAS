import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../create-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function executeRequest(app, { method, url, headers = {}, body = null }) {
  return new Promise((resolve) => {
    let statusCode = 200;
    const responseHeaders = {};
    let responseBody = "";

    const req = {
      method,
      url,
      headers: { ...headers },
      body,
      query: {},
      params: {},
      cookies: {}
    };

    // Parse cookie header if present
    if (headers["cookie"] || headers["Cookie"]) {
      const cookieHeader = headers["cookie"] || headers["Cookie"];
      cookieHeader.split(";").forEach(pair => {
        const [k, v] = pair.trim().split("=");
        if (k && v) req.cookies[k] = v;
      });
    }

    const res = {
      setHeader(name, val) {
        responseHeaders[name.toLowerCase()] = val;
      },
      getHeader(name) {
        return responseHeaders[name.toLowerCase()];
      },
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseBody = JSON.stringify(data);
        resolve({
          status: statusCode,
          headers: responseHeaders,
          json: () => Promise.resolve(data),
          text: () => Promise.resolve(responseBody)
        });
      },
      send(data) {
        responseBody = String(data);
        resolve({
          status: statusCode,
          headers: responseHeaders,
          json: () => Promise.resolve(JSON.parse(responseBody)),
          text: () => Promise.resolve(responseBody)
        });
      },
      sendFile(filePath) {
        resolve({
          status: statusCode,
          headers: responseHeaders,
          filePath
        });
      }
    };

    app.handle(req, res);
  });
}

test("reconnect endpoints validate admin auth and equipment numbers", async t => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    APP_ENV: "easypanel",
    PUBLIC_BASE_URL: "https://calls.example.test",
    DB_HOST: "mysql",
    DB_PORT: "3306",
    DB_NAME: "architecture_test",
    DB_USER: "architecture_test",
    DB_PASSWORD: "synthetic-test-password"
  });
  delete process.env.AUTH_LOCAL_ISOLATED;
  const { runtime } = createRuntime(root);

  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  // 1. Unauthenticated request should be 401
  const unauth = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/equipment/1/reconnect"
  });
  assert.equal(unauth.status, 401);

  const unauthBulk = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/reconnect"
  });
  assert.equal(unauthBulk.status, 401);

  // 2. Admin auth test
  runtime.auth.resolve = async () => ({ id: 1, username: "admin", role: "ADMINISTRADOR" });
  const headers = {
    "content-type": "application/json"
  };

  // Invalid equipment number
  const invalid = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/equipment/99/reconnect",
    headers
  });
  assert.equal(invalid.status, 404);

  // Valid equipment reconnect
  const single = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/equipment/1/reconnect",
    headers
  });
  assert.equal(single.status, 200);
  const singleData = await single.json();
  assert.equal(singleData.ok, true);
  assert.equal(singleData.result.number, 1);

  // Bulk reconnect with specific equipment
  const bulk = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/reconnect",
    headers,
    body: { equipment: [1, 2] }
  });
  assert.equal(bulk.status, 200);
  const bulkData = await bulk.json();
  assert.equal(bulkData.ok, true);
  assert.equal(bulkData.reconnectedCount, 2);
  assert.deepEqual(bulkData.numbers, [1, 2]);

  // Bulk reconnect with default (all disconnected)
  const bulkAll = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/reconnect",
    headers
  });
  assert.equal(bulkAll.status, 200);
  const bulkAllData = await bulkAll.json();
  assert.equal(bulkAllData.ok, true);

  // Reconnecting an equipment with active session and simulated device
  const session = {
    pairingSlots: [{ id: "slot-1", deviceId: "android-test-01", deviceName: "Equipo 1", linkedAt: new Date().toISOString() }],
    phoneWorkers: [{ id: "android-test-01", socketId: "sock-1", connected: false, callState: "idle" }]
  };
  runtime.sessions.set("SESS01", session);
  runtime.network.registry = [
    { position: 1, device_id: "android-test-01", session_code: "SESS01", name: "Equipo 1" }
  ];

  const simReconnect = await executeRequest(runtime.app, {
    method: "POST",
    url: "/api/network/equipment/1/reconnect",
    headers
  });
  assert.equal(simReconnect.status, 200);
  const simData = await simReconnect.json();
  assert.equal(simData.ok, true);
  assert.equal(simData.result.number, 1);
  assert.equal(simData.result.deviceId, "android-test-01");
});
