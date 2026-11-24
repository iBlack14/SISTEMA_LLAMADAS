import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerRecordings } from "../../routes/recordings.js";
import { registerSessionAccess } from "../../middleware/operational-access.js";
import { purgeExpiredRecordings } from "../../services/calls/call-recordings.js";

test("purge deletes expired audio only, in bounded batches", async () => {
  let calls = 0;
  const pool = {
    async query(sql, values) {
      assert.match(sql, /^DELETE FROM vc_call_recordings WHERE created_at <= CURRENT_TIMESTAMP\(3\) - INTERVAL 7 DAY/);
      assert.match(sql, /ORDER BY created_at LIMIT \?/);
      assert.deepEqual(values, [50]);
      return [{ affectedRows: calls++ === 0 ? 50 : 3 }];
    }
  };
  assert.equal(await purgeExpiredRecordings(pool), 53);
  assert.equal(calls, 2);
});

test("the catalog and audio require an admin, and Android can upload a confirmed answer", async t => {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.get("x-test-role");
    if (role) req.user = { role };
    next();
  });
  const audio = Buffer.from("0000ftypM4A demo audio");
  let attempt;
  const inserted = [];
  const pool = {
    async query(sql, values) {
      if (sql.includes("JOIN vc_call_attempts")) {
        assert.match(sql, /a\.report_date>=\?/);
        assert.match(sql, /r\.created_at > CURRENT_TIMESTAMP\(3\) - INTERVAL 7 DAY/);
        assert.deepEqual(values, ["2026-11-24", "Test!%%", "Test!%%", 26, 0]);
        return [[{ attemptId: "attempt-1", sessionCode: "TEST01" }]];
      }
      if (sql.includes("FROM vc_call_attempts")) return [attempt ? [attempt] : []];
      if (sql.includes("FROM vc_call_recordings")) {
        assert.match(sql, /AND created_at > CURRENT_TIMESTAMP\(3\) - INTERVAL 7 DAY/);
        return [[{ audio_data: audio, mime_type: "audio/mp4" }]];
      }
      throw new Error("Unexpected SQL");
    },
    async execute(_sql, values) { inserted.push(values); }
  };
  const auth = {
    requireAdmin(req, res, next) {
      if (!req.user) return res.sendStatus(401);
      if (req.user.role !== "ADMINISTRADOR") return res.sendStatus(403);
      next();
    },
    requireUser: (_req, res) => res.sendStatus(401),
    csrf: (_req, _res, next) => next()
  };
  const runtime = {
    app, auth, persistence: { pool },
    sessions: new Map([["TEST01", { pairingSlots: [{ token: "paired", deviceId: "worker-1" }] }]])
  };
  registerRecordings(runtime);
  registerSessionAccess(runtime, { requireDashboardAccess: (_req, res) => res.sendStatus(403) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = "/api/admin/recordings?from=2026-11-24&search=Test%25";
  const recording = "/api/session/TEST01/recordings/attempt-1";
  const admin = { "x-test-role": "ADMINISTRADOR" };
  const operator = { "x-test-role": "OPERADOR" };
  const upload = token => fetch(base + recording, {
    method: "POST", headers: { "content-type": "audio/mp4", "x-pairing-token": token }, body: audio
  });

  assert.equal((await fetch(base + catalog, { headers: operator })).status, 403);
  assert.equal((await fetch(base + recording, { headers: operator })).status, 403);
  assert.equal((await fetch(base + catalog)).status, 401);
  assert.deepEqual((await (await fetch(base + catalog, { headers: admin })).json()).rows,
    [{ attemptId: "attempt-1", sessionCode: "TEST01" }]);
  const partial = await fetch(base + recording, { headers: { ...admin, range: "bytes=-5" } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "audio");
  assert.equal((await upload("invalid")).status, 401);
  assert.equal((await upload("paired")).status, 409);
  attempt = { contact_id: "c1", phone: "", worker_id: "worker-2", ended_at: "end", connected_at: "start", technical_result: "contesto", connected_seconds: 20 };
  assert.equal((await upload("paired")).status, 403);
  attempt.worker_id = "worker-1";
  attempt.technical_result = "buzon_de_voz";
  assert.equal((await upload("paired")).status, 422);
  attempt.technical_result = "contesto";
  attempt.expired = 1;
  assert.equal((await upload("paired")).status, 410);
  attempt.expired = 0;
  assert.equal((await upload("paired")).status, 200);
  assert.deepEqual(inserted[0], ["TEST01", "attempt-1", "c1", "", "audio/mp4", 20, audio.length, audio]);
});
