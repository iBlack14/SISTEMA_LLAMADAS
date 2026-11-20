import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBook, withProgress, annualPhoneBlocks } from "../../services/campaigns/contact-book.js";
import { startCampaign, getCampaignSnapshot } from "../../services/campaigns/campaign-manager.js";

test("compact SQL progress map matches progress calculated from attempt rows", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  const attempts = [
    { phone: "900000001", durationSeconds: 12, technicalResult: "sin_respuesta", startedAt: "2026-11-18T10:00:00Z" },
    { phone: "+51 900000001", durationSeconds: 25, technicalResult: "conectado", startedAt: "2026-11-19T10:00:00Z" },
    { phone: "900000002", durationSeconds: 0, technicalResult: "numero_inexistente", startedAt: "2026-11-19T09:00:00Z" }
  ];
  const compact = new Map([
    ["900000001", { count: 2, duration: 37, result: "conectado" }],
    ["900000002", { count: 1, duration: 0, result: "numero_inexistente" }]
  ]);
  const book = normalizeBook({ contacts: [{ id: "a", phone: "900000001" }, { id: "b", phone: "900000002" }] });
  const fullResult = withProgress(book, attempts, attempts, now);
  const compactResult = withProgress(book, compact, annualPhoneBlocks(attempts, now), now);
  assert.deepEqual(compactResult, fullResult);
});

test("campaign snapshot omits nested attempt history and caps returned history at 100", () => {
  const session = {};
  startCampaign(session, [{ id: "a", phone: "900000001", attemptHistory: [{ secret: "detail" }] }]);
  session.campaign.history = Array.from({ length: 140 }, (_, i) => ({ attemptId: String(i) }));
  const snapshot = getCampaignSnapshot(session);
  assert.equal(snapshot.contacts.length, 1);
  assert.equal("attemptHistory" in snapshot.contacts[0], false);
  assert.equal(snapshot.history.length, 100);
  assert.equal(snapshot.history[0].attemptId, "40");
  assert.equal(snapshot.history.at(-1).attemptId, "139");
  assert.equal(session.campaign.history.length, 140);
});
