import test from "node:test";
import assert from "node:assert/strict";
import { dashboardSessionKeys, readDashboardSession } from "../web/modules/dashboard-session.js";

const storage = entries => {
  const values = new Map(Object.entries(entries));
  return { getItem: key => values.get(key) ?? null };
};

test("reports use the current account and ignore a stale anonymous workspace", () => {
  const saved = storage({
    "voip vc.dashboardSessionCode": "OLD001",
    "voip vc.dashboardToken.OLD001": "old-token",
    "voip vc.auth.7.dashboardSessionCode": " live07 ",
    "voip vc.auth.7.dashboardToken.LIVE07": " current-token "
  });
  assert.deepEqual(readDashboardSession(saved, 7), { code: "LIVE07", token: "current-token" });
});

test("switching users never reuses the previous account workspace or token", () => {
  const saved = storage({
    "voip vc.auth.7.dashboardSessionCode": "USER07",
    "voip vc.auth.7.dashboardToken.USER07": "token-7",
    "voip vc.auth.8.dashboardSessionCode": "USER08",
    "voip vc.auth.8.dashboardToken.USER08": "token-8"
  });
  assert.deepEqual(readDashboardSession(saved, 8), { code: "USER08", token: "token-8" });
  assert.deepEqual(readDashboardSession(saved, 9), { code: "", token: "" });
});

test("an unauthenticated or uninitialized report never reads legacy credentials", () => {
  const saved = { getItem() { throw new Error("Storage must not be read without an account"); } };
  assert.deepEqual(readDashboardSession(saved, undefined), { code: "", token: "" });
  assert.equal(dashboardSessionKeys(null), null);
});

test("a missing account token does not fall back to the anonymous token", () => {
  const saved = storage({
    "voip vc.auth.7.dashboardSessionCode": "USER07",
    "voip vc.dashboardToken.USER07": "legacy-token"
  });
  assert.deepEqual(readDashboardSession(saved, 7), { code: "USER07", token: "" });
});
