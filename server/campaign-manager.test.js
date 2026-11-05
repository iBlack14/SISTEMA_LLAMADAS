import test from "node:test";
import assert from "node:assert/strict";
import { startCampaign, ensureCampaign, assignNextContact, assignSpecificContact,
  updateActiveCallState, ensureCampaignContact } from "./campaign-manager.js";

const worker = (id) => ({ id, name: id, socketId: id, callState: "idle" });
const contacts = [
  { id: "a", phone: "999111222", name: "A", list: "Lista" },
  { id: "b", phone: "+51 999 111 222", name: "Duplicado", list: "Otra lista" },
  { id: "c", phone: "999333444", name: "C", list: "Lista" }
];

test("deduplicates formatted phone numbers across lists", () => {
  const session = {};
  startCampaign(session, contacts);
  assert.equal(session.campaign.contacts.length, 2);
  assert.equal(assignNextContact(session, worker("one")).phone, "999111222");
  assert.equal(assignNextContact(session, worker("two")).phone, "999333444");
  assert.equal(assignNextContact(session, worker("one")), null);
});

test("manual redial preserves earlier attempts and rejects busy workers", () => {
  const session = {};
  startCampaign(session, contacts);
  const contact = assignNextContact(session, worker("one"));
  const callId = contact.currentAttemptId;
  assert.equal(assignSpecificContact(session, worker("one"), contact.id), null);
  updateActiveCallState(session, "in_call", worker("one"), { callId });
  updateActiveCallState(session, "ended", worker("one"), { callId });
  assert.equal(session.campaign.history.length, 1);
  assert.equal(assignSpecificContact(session, { ...worker("one"), callState: "in_call" }, contact.id), null);
  const retry = assignSpecificContact(session, worker("one"), contact.id);
  assert.ok(retry);
  assert.notEqual(retry.currentAttemptId, callId);
  assert.equal(session.campaign.history.length, 1);
  assert.equal(retry.attemptHistory.length, 2);
  assert.equal(updateActiveCallState(session, "ended", worker("one"), { callId }), null);
  assert.equal(retry.status, "dialing");
});

test("late dialing cannot undo a confirmed answer; transient idle cannot release it", () => {
  const session = {};
  startCampaign(session, contacts);
  const contact = assignNextContact(session, worker("one"));
  updateActiveCallState(session, "in_call", worker("one"));
  assert.equal(updateActiveCallState(session, "dialing", worker("one")), null);
  updateActiveCallState(session, "idle", worker("one"));
  assert.equal(contact.status, "in_call");
  assert.ok(session.campaign.assignments.one);
});

test("starting another campaign retains the report and the contact attempt history", () => {
  const session = {};
  startCampaign(session, contacts);
  const contact = assignNextContact(session, worker("one"));
  updateActiveCallState(session, "ended", worker("one"));
  startCampaign(session, [{ id: "new-id", phone: "+51 999 111 222" }]);
  assert.equal(ensureCampaign(session).history.length, 1);
  assert.equal(session.campaign.contacts[0].attemptHistory.length, 1);
  assert.equal(contact.attemptHistory.length, 1);
  const next = assignNextContact(session, worker("one"));
  assert.equal(next.phone, "999111222");
  assert.equal(next.attemptHistory.at(-1).number, 2);
});

test("manual redial does not resume a completed campaign", () => {
  const session = {};
  startCampaign(session, contacts);
  session.campaign.status = "completed";
  assert.ok(assignSpecificContact(session, worker("one"), "a"));
  assert.equal(session.campaign.status, "paused");
  updateActiveCallState(session, "ended", worker("one"));
  assert.equal(assignNextContact(session, worker("two")), null);
});

test("legacy duplicate contacts cannot call the same number concurrently", () => {
  const session = {};
  startCampaign(session, contacts);
  session.campaign.contacts.push({ ...session.campaign.contacts[0], id: "legacy", attemptHistory: [] });
  assignNextContact(session, worker("one"));
  assert.equal(assignSpecificContact(session, worker("two"), "legacy"), null);
  const other = assignNextContact(session, worker("two"));
  assert.equal(other.phone, "999333444");
  assert.equal(assignNextContact(session, worker("three")), null);
});

test("existing ownership cannot be changed by a manual-call request", () => {
  const session = {};
  startCampaign(session, [{ ...contacts[0], targetWorkerId: "one" }]);
  const contact = ensureCampaignContact(session, { id: "a", targetWorkerId: "two" });
  assert.equal(contact.targetWorkerId, "one");
  assert.equal(assignSpecificContact(session, worker("two"), "a"), null);
  assert.equal(ensureCampaignContact(session, { id: "duplicate", phone: "+51 999111222" }).id, "a");
});
