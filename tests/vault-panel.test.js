"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require(process.env.JSDOM_MODULE || "jsdom");
const webcrypto = require("node:crypto").webcrypto;
globalThis.crypto = webcrypto;
const api = require("../vault.js");
const {backend, worker} = require("./vault-browser-harness.js");
const KEY = "capurnionEncryptedVault", phrase = "correct horse battery staple";
const root = path.join(__dirname, "..");
async function until(fn) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw new Error("Panel condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function panel(store) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), {url: "https://extension-test.invalid/options.html", runScripts: "outside-only"});
  const w = dom.window;
  Object.defineProperty(w, "crypto", {value: webcrypto});
  Object.defineProperty(w.navigator, "locks", {value: store.locks});
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.indexedDB = store.indexedDB;
  w.confirm = () => true;
  let idle, closed = false;
  const nativeTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => ms === 300000 ? (idle = fn, 900001) : nativeTimeout(fn, ms);
  w.CAPURNION_RULES = {vault: {enabled: true}};
  w.chrome = {storage: {local: {get: store.get, set: store.set, async setAccessLevel() {}},
    onChanged: {addListener(fn) { store.listeners.push((...args) => { if (!closed) fn(...args); }); }}}, runtime: {}};
  for (const file of ["vault.js", "vault-device-key.js", "vault-runtime.js"])
    w.eval(fs.readFileSync(path.join(root, file), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "options.js"), "utf8"));
  const element = id => w.document.getElementById(id);
  await until(() => !element("unlock-form").hidden);
  async function submit(form) {
    element(form).dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await until(() => !element("unlock").disabled);
  }
  async function unlock(create = false, password = phrase) {
    element("passphrase").value = password;
    if (create) element("confirm").value = password;
    await submit("unlock-form");
  }
  async function save(name, value) { element("secret-name").value = name; element("secret-value").value = value; await submit("secret-form"); }
  return {w, element, submit, unlock, save, expire: () => idle(), close() { closed = true; w.close(); }};
}
test("panel creates, adds, edits, reveals, deletes, and locks secrets with only ciphertext in storage", async () => {
  const store = backend(), p = await panel(store);
  try {
    await p.unlock(true); assert.equal(p.element("unlocked").hidden, false);
    await p.save("my-token", "very-private-token-value");
    assert(!JSON.stringify(store.records).includes("very-private-token-value"));
    assert(!JSON.stringify(store.records).includes("my-token"));
    const row = p.element("entries").querySelector(".entry");
    assert.equal(row.querySelector("input").type, "password");
    row.querySelector("button").click(); assert.equal(row.querySelector("input").type, "text");
    row.querySelectorAll("button")[1].click(); await p.save("renamed-token", "new-private-value");
    assert.equal(p.element("entries").querySelector("h3").textContent, "renamed-token");
    p.element("lock").click(); assert.equal(p.element("unlocked").hidden, true);
    assert.equal(p.element("entries").children.length, 0); assert.equal(p.element("secret-value").value, "");
    assert.match(p.element("automation-status").textContent, /available/);
    assert.equal(await worker(store).access.getSecret("renamed-token"), "new-private-value");
    await p.unlock(false, "the wrong long passphrase"); assert.equal(p.element("unlocked").hidden, true);
    await p.unlock(); assert.equal(p.element("unlocked").hidden, false);
    p.element("entries").querySelectorAll("button")[2].click(); await until(() => !p.element("unlock").disabled);
    assert.equal((await api.unlock(phrase, store.records[KEY])).data.entries.length, 0);
  } finally { p.close(); }
});
test("passphrase changes, page closure, idle locking and input clearing", async () => {
  const store = backend(), p = await panel(store);
  try {
    await p.unlock(true); await p.save("secret", "test-value");
    p.element("new-passphrase").value = "a replacement long password"; p.element("new-confirm").value = "a replacement long password";
    await p.submit("password-form");
    await assert.rejects(api.unlock(phrase, store.records[KEY]));
    assert.equal((await api.unlock("a replacement long password", store.records[KEY])).data.entries[0].value, "test-value");
    p.expire(); assert.equal(p.element("unlocked").hidden, true);
    assert.equal(await worker(store).access.getSecret("secret"), "test-value");
    await p.unlock(false, "a replacement long password");
    p.w.dispatchEvent(new p.w.Event("pagehide")); assert.equal(p.element("entries").children.length, 0);
    assert.equal(p.element("passphrase").value, "");
    p.close();
    assert.equal(await worker(store).access.getSecret("secret"), "test-value");
  } finally { p.close(); }
});
test("another panel changing the vault locks stale plaintext and concurrent creation does not overwrite", async () => {
  const store = backend(), first = await panel(store), second = await panel(store);
  try {
    await Promise.all([first.unlock(true), second.unlock(true)]);
    const unlocked = [first, second].filter(p => !p.element("unlocked").hidden);
    assert.equal(unlocked.length, 1);
    const other = unlocked[0] === first ? second : first;
    await other.unlock(); assert.equal(other.element("unlocked").hidden, false);
    await unlocked[0].save("a-secret", "a-private-value");
    assert.equal(other.element("unlocked").hidden, true); assert.equal(other.element("entries").children.length, 0);
  } finally { first.close(); second.close(); }
});
test("names are rendered as text and never interpreted as HTML", async () => {
  const store = backend(), p = await panel(store);
  try {
    await p.unlock(true); await p.save('<img src=x onerror="alert(1)">', "literal-value");
    assert.equal(p.element("entries").querySelectorAll("img").length, 0);
  } finally { p.close(); }
});
test("an existing vault needs one management unlock and a lost device key can be restored", async () => {
  const store = backend();
  const original = await api.create(phrase, {entries: [{id: "old-entry", name: "existing-secret", value: "existing-value", updatedAt: 1}]});
  await store.set({[KEY]: original.record});
  const p = await panel(store);
  try {
    assert.match(p.element("automation-status").textContent, /unlock management once/);
    await p.unlock(false, "incorrect long passphrase");
    assert.equal((await worker(store).access.status()).ready, false);
    await p.unlock(); p.element("lock").click();
    assert.equal(await worker(store).access.getSecret("existing-secret"), "existing-value");
    assert.deepEqual(store.records[KEY], original.record);
    store.indexedDB.databases.clear();
    await assert.rejects(worker(store).access.getSecret("existing-secret"), /Unlock vault management/);
    await p.unlock(); p.element("lock").click();
    assert.equal(await worker(store).access.getSecret("existing-secret"), "existing-value");
  } finally { p.close(); }
});
test("failed key or ciphertext writes leave both the previous passphrase and background secret usable", async () => {
  const store = backend(), p = await panel(store);
  try {
    await p.unlock(true); await p.save("test-secret", "original-secret");
    const revision = store.records[KEY].revision;
    for (const fail of [() => store.indexedDB.failNextWrite(), () => store.failNextWrite()]) {
      p.element("new-passphrase").value = "replacement long passphrase";
      p.element("new-confirm").value = "replacement long passphrase";
      fail(); await p.submit("password-form");
      assert.match(p.element("error").textContent, /failure|Cannot access/);
      assert.equal(store.records[KEY].revision, revision);
      assert.equal((await api.unlock(phrase, store.records[KEY])).data.entries[0].value, "original-secret");
      assert.equal(await worker(store).access.getSecret("test-secret"), "original-secret");
    }
  } finally { p.close(); }
});
