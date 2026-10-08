"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {backend, worker} = require("./vault-browser-harness.js");
const KEY = "capurnionEncryptedVault", phrase = "correct horse battery staple";
const data = {entries: [{id: "secret-id", name: "login-password", value: "private-test-value-123", updatedAt: 1}]};
async function persist(store, next) {
  const w = worker(store);
  await w.keys.put(next.record, next.key); await store.set({[KEY]: next.record}); await w.keys.prune(next.record);
}
test("persistent CryptoKey remains non-exportable and fresh workers decrypt without a passphrase", async () => {
  const store = backend(), w = worker(store), created = await w.vault.create(phrase, data);
  await persist(store, created);
  for (const value of [phrase, data.entries[0].name, data.entries[0].value]) assert(!JSON.stringify(store.records).includes(value));
  for (let restart = 0; restart < 3; restart++) {
    const fresh = worker(store);
    assert.equal((await fresh.access.status()).ready, true);
    const savedKey = await fresh.keys.get(created.record);
    assert.equal(savedKey.extractable, false);
    await assert.rejects(fresh.context.crypto.subtle.exportKey("raw", savedKey));
    assert.equal(await fresh.access.getSecret("login-password"), data.entries[0].value);
  }
});
test("missing device key, missing vault, missing secret and disabled capability fail closed", async () => {
  const store = backend(), w = worker(store);
  assert.equal((await w.access.status()).reason, "no-vault");
  await assert.rejects(w.access.getSecret("login-password"), /Create a vault/);
  const created = await w.vault.create(phrase, data); await store.set({[KEY]: created.record});
  assert.equal((await w.access.status()).reason, "unlock-once");
  await assert.rejects(w.access.getSecret("login-password"), /Unlock vault management/);
  await persist(store, created);
  await assert.rejects(w.access.getSecret("unknown-secret"), /not found/);
  await assert.rejects(w.access.getSecret(""), /Invalid secret name/);
  await assert.rejects(worker(store, false).access.getSecret("login-password"), /disabled/);
});
test("updated values, deletion and passphrase changes are immediately visible to an existing worker", async () => {
  const store = backend(), w = worker(store), created = await w.vault.create(phrase, data);
  await persist(store, created);
  const nextData = {entries: [{...data.entries[0], value: "replacement-secret"}]};
  const changed = await w.vault.create("replacement long passphrase", nextData);
  await persist(store, changed);
  assert.equal(await w.keys.get(created.record), null);
  assert.equal(await w.access.getSecret("login-password"), "replacement-secret");
  const cleared = await w.vault.seal(changed.key, {entries: []}, changed.record.kdf);
  await store.set({[KEY]: cleared});
  await assert.rejects(w.access.getSecret("login-password"), /not found/);
});
test("ciphertext or metadata tampering does not reveal a secret", async () => {
  const store = backend(), w = worker(store), created = await w.vault.create(phrase, data);
  await persist(store, created);
  for (const field of ["ciphertext", "revision"]) {
    const changed = structuredClone(created.record);
    if (field === "revision") changed.revision = "tampered";
    else { const bytes = Buffer.from(changed.cipher.ciphertext, "base64"); bytes[0] ^= 1; changed.cipher.ciphertext = bytes.toString("base64"); }
    await store.set({[KEY]: changed});
    await assert.rejects(w.access.getSecret("login-password"), /incorrect|damaged/);
  }
});
test("a concurrent replacement is retried before returning a removed or changed secret", async () => {
  const store = backend(), w = worker(store), created = await w.vault.create(phrase, data);
  await persist(store, created);
  const changed = await w.vault.seal(created.key, {entries: []}, created.record.kdf);
  const open = w.vault.open;
  let replace = true;
  w.vault.open = async (...args) => {
    const result = await open(...args);
    if (replace) { replace = false; await store.set({[KEY]: changed}); }
    return result;
  };
  await assert.rejects(w.access.getSecret("login-password"), /not found/);
});
test("failed device-key writes do not destroy a previously working key", async () => {
  const store = backend(), w = worker(store), created = await w.vault.create(phrase, data);
  await persist(store, created);
  const changed = await w.vault.create("replacement long passphrase", data);
  store.indexedDB.failNextWrite();
  await assert.rejects(w.keys.put(changed.record, changed.key), /Cannot access/);
  assert.equal(await worker(store).access.getSecret("login-password"), data.entries[0].value);
});
test("the real background bootstrap loads the access API only when enabled and exposes no secret message endpoint", async () => {
  const store = backend(), created = await worker(store).vault.create(phrase, data);
  await persist(store, created);
  for (const enabled of [true, false]) {
    const w = worker(store), imported = [], listeners = [];
    delete w.context.CAPURNION_VAULT_ACCESS;
    w.context.chrome.action = {onClicked: {addListener() {}}};
    w.context.chrome.runtime = {onMessage: {addListener(fn) { listeners.push(fn); }}};
    w.context.importScripts = (...files) => {
      for (const file of files) {
        imported.push(file);
        if (file === "rules.generated.js") { w.context.CAPURNION_RULES = {vault: {enabled}}; continue; }
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), w.context);
      }
    };
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), w.context);
    if (enabled) {
      assert.equal(await w.context.CAPURNION_VAULT_ACCESS.getSecret("login-password"), data.entries[0].value);
      assert(imported.includes("vault-device-key.js"));
    } else {
      assert.equal(w.context.CAPURNION_VAULT_ACCESS, undefined);
      assert.deepEqual(imported, ["rules.generated.js"]);
    }
    assert.equal(listeners.length, 0);
  }
});
