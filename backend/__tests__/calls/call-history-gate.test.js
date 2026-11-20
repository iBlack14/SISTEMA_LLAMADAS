import test from "node:test";
import assert from "node:assert/strict";
import { CallHistoryGate } from "../../services/calls/call-history-gate.js";

test("pending retry only saves sessions with failed or dirty writes", async () => {
  const sessions = new Map([["AR", {}], ["CX", {}]]);
  const saves = [];
  let failFirstSave = true;
  const persistence = {
    status: () => ({ mode: failFirstSave ? "pending" : "mysql" }),
    getPendingSessionCodes: () => ["AR"],
    save: async (_sessions, codes) => {
      saves.push(codes);
      if (failFirstSave) {
        failFirstSave = false;
        throw new Error("simulated storage outage");
      }
      return { committed: true };
    }
  };
  const gate = new CallHistoryGate(persistence, () => sessions);

  await assert.rejects(gate.commit("AR", "call-1:dialing", () => {}), /simulated storage outage/);
  await gate.retryPending();

  assert.deepEqual(saves, [["AR"], ["AR"]]);
  assert.equal(gate.failed.size, 0);
});

test("pending retry retains full-snapshot fallback when no dirty session is known", async () => {
  const sessions = new Map([["AR", {}], ["CX", {}]]);
  let savedCodes = "unset";
  const persistence = {
    status: () => ({ mode: "pending" }),
    getPendingSessionCodes: () => [],
    save: async (_sessions, codes) => { savedCodes = codes; return { committed: true }; }
  };
  const gate = new CallHistoryGate(persistence, () => sessions);

  await gate.retryPending();

  assert.equal(savedCodes, null);
});
