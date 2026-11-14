import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MESSAGE_CONTACTS, normalizeMessageContacts, upsertMessageContact } from "./message-contacts.js";

test("upserts message contacts by normalized phone number", () => {
  const first = upsertMessageContact([], { name: " Ana ", phone: "+51 900-000-001" }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(first.contact.name, "Ana");
  assert.equal(first.contact.phone, "51900000001");

  const second = upsertMessageContact(first.contacts, { name: "Ana Pérez", phone: "51900000001" }, new Date("2026-01-02T00:00:00Z"));
  assert.equal(second.contacts.length, 1);
  assert.equal(second.contact.name, "Ana Pérez");
  assert.equal(second.contact.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(second.contact.updatedAt, "2026-01-02T00:00:00.000Z");
});

test("normalizes persisted entries and rejects invalid numbers or a full list", () => {
  assert.deepEqual(normalizeMessageContacts([{ name: "Bad", phone: "123" }, { name: "Good", phone: "900000001" }])
    .map(({ phone }) => phone), ["900000001"]);
  assert.match(upsertMessageContact([], { name: "Bad", phone: "123" }).error, /número válido/);

  const full = Array.from({ length: MAX_MESSAGE_CONTACTS }, (_, index) => ({
    name: `Contact ${index}`,
    phone: String(100000000 + index)
  }));
  assert.match(upsertMessageContact(full, { name: "New", phone: "999999999" }).error, /límite/);
  assert.equal(upsertMessageContact(full, { name: "Updated", phone: full[0].phone }).contacts.length, MAX_MESSAGE_CONTACTS);
});
