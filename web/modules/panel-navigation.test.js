import assert from "node:assert/strict";
import { test } from "node:test";
import { panelHashes, showPanelView } from "./panel-navigation.js";

test("panel visibility, active event and URL stay synchronized", () => {
  const sections = {
    calls: "callsContent",
    contacts: "contactsContent",
    reports: "annualReport",
    blocked: "blockedNumbersView",
    messages: "messagesView"
  };
  const elements = new Map(Object.values(sections).map(id => [id, { hidden: false }]));
  const events = [];
  const hashes = [];
  const originals = Object.fromEntries(["window", "document", "history"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    globalThis.window = { location: { hash: "#contactos" } };
    globalThis.history = {
      pushState: (_state, _title, hash) => {
        hashes.push(hash);
        window.location.hash = hash;
      }
    };
    globalThis.document = {
      getElementById: id => elements.get(id),
      dispatchEvent: event => events.push(event.detail)
    };

    for (const view of Object.keys(sections)) {
      showPanelView(view);
      assert.equal(window.location.hash, panelHashes[view]);
      assert.equal(events.at(-1), view);
      assert.deepEqual([...elements].filter(([, element]) => !element.hidden).map(([id]) => id), [sections[view]]);
      const count = hashes.length;
      showPanelView(view);
      assert.equal(hashes.length, count, "reopening a panel must not add history");
    }

    // Browser history already changed the URL before restoring its panel.
    window.location.hash = "#contactos";
    const count = hashes.length;
    showPanelView("contacts");
    assert.equal(hashes.length, count);
    assert.equal(elements.get("contactsContent").hidden, false);

    showPanelView("users");
    assert.equal(window.location.hash, "#contactos");
    assert.equal(events.at(-1), "contacts");
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
