import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { registerReports } from "../../routes/reports.js";

test("large admin and employee report responses are compressed before sending", async () => {
  const app = express();
  const session = { ownerUserId: 1 };
  const report = { rows: Array.from({ length: 1000 }, (_, index) => ({
    id: index, phone: `900${String(index).padStart(6, "0")}`, name: "Contacto de prueba"
  })) };
  const runtime = {
    app,
    sessions: new Map([["TEST01", session]]),
    auth: {
      requireAdmin: (_req, _res, next) => next(),
      pool: { query: async () => [[{ id: 1, username: "admin" }]] }
    },
    persistence: { status: () => ({ ok: true }) }
  };
  const services = { reportData: () => [report] };
  registerReports(runtime, services);

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/api/reports/all?date=2026-11-18", "/api/session/TEST01/reports/daily?date=2026-11-19"]) {
      const response = await fetch(base + path, { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-encoding"), "gzip");
      assert.ok(Number(response.headers.get("content-length")) < 10000);
      assert.equal((await response.json()).reports[0].rows.length, 1000);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
