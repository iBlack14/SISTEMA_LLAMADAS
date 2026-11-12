import test from "node:test";
import assert from "node:assert/strict";
import { isAnsweredAttempt, isVoicemailAttempt, isInoperableAttempt, attemptResultLabel, summarizeAttempts } from "../web/modules/report-metrics.js";

test("detected voicemail overrides network connection timestamps and stale answered flags", () => {
  for (const durationSeconds of [2, 3, 60]) {
    const row = { technicalResult: "buzon_de_voz", disposition: "buzon_de_voz",
      answeredAt: "2026-11-11T23:31:01Z", endedAt: "2026-11-11T23:31:03Z",
      answered: true, durationSeconds };
    assert.equal(isAnsweredAttempt(row), false);
    assert.equal(isVoicemailAttempt(row), true);
    assert.equal(attemptResultLabel(row), "BUZÓN DE VOZ");
    assert.equal(summarizeAttempts([row]).unanswered, 1);
  }
});

test("a mailbox disposition overrides a stale generic answered result", () => {
  const row = {technicalResult: "contesto", disposition: "buzon_de_voz", endedAt:"2026-11-11T23:31:03Z"};
  assert.equal(isAnsweredAttempt(row), false);
  assert.equal(attemptResultLabel(row), "BUZÓN DE VOZ");
  assert.equal(summarizeAttempts([row]).answered, 0);
});

test("duration alone never proves that a person answered", () => {
  assert.equal(isAnsweredAttempt({durationSeconds: 90}), false);
  assert.equal(attemptResultLabel({durationSeconds: 90}), "PENDIENTE");
  assert.equal(isAnsweredAttempt({technicalResult: "contesto", durationSeconds: 2}), true);
});

test("operator failures are not counted as human answers even after network connection", () => {
  for (const technicalResult of ["sin_servicio", "no_disponible", "numero_inexistente"]) {
    assert.equal(isAnsweredAttempt({technicalResult, answeredAt:"2026-11-11T23:31:01Z"}), false);
  }
});
