/* Extension-origin IndexedDB holds CryptoKeys, never exported key bytes. */
(() => {
  "use strict";
  const DATABASE = "capurnion-vault-device-keys", STORE = "keys";
  function id(record) {
    CAPURNION_VAULT.validateRecord(record);
    return `pbkdf2-sha256-600000:${record.kdf.salt}`;
  }
  function validKey(key) {
    if (!key || key.type !== "secret" || key.extractable !== false ||
        key.algorithm?.name !== "AES-GCM" || key.algorithm.length !== 256 ||
        key.usages.length !== 2 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt"))
      throw new Error("Invalid vault device key");
    return key;
  }
  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, {keyPath: "id"});
      request.onerror = () => reject(new Error("Cannot open the vault device key store"));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Vault device key store is busy; close other extension panels"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  async function transaction(mode, operation) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let value;
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(new Error("Cannot access the vault device key store"));
        try { operation(tx.objectStore(STORE), result => { value = result; }); }
        catch (error) { tx.abort(); reject(error); }
      });
    } finally { db.close(); }
  }
  async function get(record) {
    const keyId = id(record);
    const key = await transaction("readonly", (store, result) => {
      const request = store.get(keyId);
      request.onsuccess = () => result(request.result?.key || null);
    });
    return key ? validKey(key) : null;
  }
  async function put(record, key) {
    const keyId = id(record); validKey(key);
    await transaction("readwrite", store => { store.put({id: keyId, key}); });
  }
  // Called under the management write lock, after ciphertext is committed.
  async function prune(record) {
    const keep = id(record);
    await transaction("readwrite", store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.key !== keep) cursor.delete();
        cursor.continue();
      };
    });
  }
  globalThis.CAPURNION_VAULT_KEYS = {get, put, prune};
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.CAPURNION_VAULT_KEYS;
})();
