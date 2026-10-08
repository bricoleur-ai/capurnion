/* Native Web Crypto; names and values are persisted only as ciphertext. */
(() => {
  "use strict";
  const ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", {fatal: true});
  const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
  function decode(value, length) {
    if (typeof value !== "string" || value.length > 500000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      throw new Error("Invalid encrypted vault format");
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (length && bytes.length !== length) throw new Error("Invalid encrypted vault format");
    return bytes;
  }
  function validData(data) {
    if (!data || !Array.isArray(data.entries) || data.entries.length > 200)
      throw new Error("Invalid vault contents");
    const names = new Set(), ids = new Set();
    for (const entry of data.entries) {
      if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
          typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 100 || names.has(entry.name) ||
          typeof entry.value !== "string" || !entry.value || entry.value.length > 32768 ||
          !Number.isSafeInteger(entry.updatedAt)) throw new Error("Invalid vault entry");
      names.add(entry.name); ids.add(entry.id);
    }
    return data;
  }
  function validateRecord(record) {
    if (record?.version !== 1 || record.kdf?.name !== "PBKDF2" || record.kdf.hash !== "SHA-256" ||
        record.kdf.iterations !== ITERATIONS || typeof record.revision !== "string" || !record.revision ||
        record.cipher?.name !== "AES-GCM") throw new Error("Unsupported encrypted vault format");
    decode(record.kdf.salt, 16); decode(record.cipher.iv, 12);
    if (decode(record.cipher.ciphertext).length < 16) throw new Error("Invalid encrypted vault format");
  }
  function password(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024)
      throw new Error("Use a passphrase with 12–1024 characters");
  }
  async function derive(passphrase, kdf) {
    password(passphrase);
    const bytes = encoder.encode(passphrase);
    try {
      const material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
      return await crypto.subtle.deriveKey({name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS,
        salt: decode(kdf.salt, 16)}, material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
    } finally { bytes.fill(0); }
  }
  const aad = record => encoder.encode(JSON.stringify({version: record.version, revision: record.revision,
    kdf: {name: record.kdf.name, hash: record.kdf.hash, iterations: record.kdf.iterations, salt: record.kdf.salt}, cipher: record.cipher.name}));
  async function seal(key, data, kdf) {
    validData(data);
    const record = {version: 1, revision: crypto.randomUUID(), kdf: {...kdf},
      cipher: {name: "AES-GCM", iv: encode(crypto.getRandomValues(new Uint8Array(12)))}};
    const bytes = encoder.encode(JSON.stringify(data));
    if (bytes.length > 300000) { bytes.fill(0); throw new Error("Vault exceeds the 300 KB size limit"); }
    try {
      record.cipher.ciphertext = encode(new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM",
        iv: decode(record.cipher.iv, 12), additionalData: aad(record), tagLength: 128}, key, bytes)));
      return record;
    } finally { bytes.fill(0); }
  }
  async function create(passphrase, data = {entries: []}) {
    const kdf = {name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS,
      salt: encode(crypto.getRandomValues(new Uint8Array(16)))};
    const key = await derive(passphrase, kdf);
    return {key, data: validData(data), record: await seal(key, data, kdf)};
  }
  async function open(key, record) {
    validateRecord(record);
    let bytes;
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: decode(record.cipher.iv, 12),
        additionalData: aad(record), tagLength: 128}, key, decode(record.cipher.ciphertext)));
      return {key, data: validData(JSON.parse(decoder.decode(bytes)))};
    } catch { throw new Error("Passphrase is incorrect or the encrypted vault is damaged"); }
    finally { bytes?.fill(0); }
  }
  async function unlock(passphrase, record) {
    validateRecord(record);
    return open(await derive(passphrase, record.kdf), record);
  }
  globalThis.CAPURNION_VAULT = {create, unlock, open, seal, validData, validateRecord};
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.CAPURNION_VAULT;
})();
