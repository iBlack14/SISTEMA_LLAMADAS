import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBook } from "../../server/contact-book.js";

test("browser imports once, then edits and deletions are confirmed by database transport", async () => {
  const legacy = new Map([["voip vc.contacts",JSON.stringify([{id:"old",phone:"900000001",list:"Importada"}])]]);
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = new EventTarget();
  globalThis.localStorage = {
    getItem:key=>legacy.get(key) ?? null, removeItem:key=>legacy.delete(key),
    setItem(){throw new Error("business data must not be written to localStorage");}
  };
  try {
    const contacts = await import("./contacts.js?mysql-test");
    contacts.loadContacts();
    contacts.loadCalledCounts();
    let book = null, revision = 0, writes = 0;
    await contacts.connectDatabase("TEST",async (method,body) => {
      if(method==="GET") return {book,revision};
      assert.equal(body.revision,revision);
      book = normalizeBook(body.book);
      writes++;
      return {revision:++revision};
    });
    assert.equal(book.contacts.length,1);
    assert.equal(legacy.has("voip vc.contacts"),false);
    contacts.addContacts([{id:"new",phone:"900000002"}],"Importada");
    contacts.setPreference("pairingListAssignments",{slot:"Importada"});
    await contacts.flushDatabase();
    assert.equal(book.contacts.length,2);
    assert.equal(book.preferences.pairingListAssignments.slot,"Importada");
    contacts.deleteList("Importada");
    await contacts.flushDatabase();
    assert.equal(book.contacts.length,0);
    assert.ok(writes>=3);
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});
