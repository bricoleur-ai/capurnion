"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto?.subtle) globalThis.crypto = require("node:crypto").webcrypto;
const vault = require("../vault.js");
const phrase = "correct horse battery staple";
const data = {entries: [{id: "test-id", name: "snowflake-test-key", value: "private-test-token-123456789", updatedAt: 1791413188411}]};
test("round-trip encryption stores neither names, values nor passphrase; key cannot be exported", async () => {
  const created = await vault.create(phrase, data);
  for (const secret of [phrase, data.entries[0].name, data.entries[0].value]) assert(!JSON.stringify(created.record).includes(secret));
  assert.equal(created.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", created.key));
  const opened = await vault.unlock(phrase, created.record);
  assert.deepEqual(opened.data, data);
});
test("wrong passphrase and tampered ciphertext, revision or salt cannot decrypt", async () => {
  const {record} = await vault.create(phrase, data);
  await assert.rejects(vault.unlock("a different passphrase", record), /incorrect|damaged/);
  for (const field of ["ciphertext", "revision", "salt"]) {
    const changed = structuredClone(record);
    if (field === "revision") changed.revision = "tampered-revision";
    else {
      const container = field === "salt" ? changed.kdf : changed.cipher;
      const bytes = Buffer.from(container[field], "base64"); bytes[0] ^= 1; container[field] = bytes.toString("base64");
    }
    await assert.rejects(vault.unlock(phrase, changed));
  }
});
test("each save uses a new nonce and passphrase changes preserve entries", async () => {
  const original = await vault.create(phrase, data);
  const second = await vault.seal(original.key, data, original.record.kdf);
  assert.notEqual(second.cipher.iv, original.record.cipher.iv);
  assert.notEqual(second.cipher.ciphertext, original.record.cipher.ciphertext);
  const changed = await vault.create("replacement long passphrase", data);
  assert.notEqual(changed.record.kdf.salt, original.record.kdf.salt);
  await assert.rejects(vault.unlock(phrase, changed.record));
  assert.deepEqual((await vault.unlock("replacement long passphrase", changed.record)).data, data);
});
test("rejects short passphrases, duplicate names, malformed records and oversized vaults", async () => {
  await assert.rejects(vault.create("short"));
  await assert.rejects(vault.create(phrase, {entries: [data.entries[0], {...data.entries[0], id: "another-id"}]}));
  await assert.rejects(vault.unlock(phrase, {version: 999}));
  const tooLarge = {entries: Array.from({length: 10}, (_, i) => ({id: String(i), name: String(i), value: "x".repeat(32768), updatedAt: 1}))};
  await assert.rejects(vault.create(phrase, tooLarge), /size limit/);
});
