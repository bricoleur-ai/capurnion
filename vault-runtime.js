/* Trusted extension code only. No message handler exposes secrets to webpages. */
(() => {
  "use strict";
  const STORAGE_KEY = "capurnionEncryptedVault";
  let access;
  async function current() {
    if (!globalThis.CAPURNION_RULES?.vault?.enabled) throw new Error("Vault is disabled");
    access ||= chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"}).catch(error => {
      access = null; throw error;
    });
    await access;
    return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || null;
  }
  async function status() {
    const record = await current();
    if (!record) return {ready: false, reason: "no-vault"};
    return await CAPURNION_VAULT_KEYS.get(record) ? {ready: true} : {ready: false, reason: "unlock-once"};
  }
  async function getSecret(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("Invalid secret name");
    // Read fresh ciphertext for every use, including after a worker restart.
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await current();
      if (!record) throw new Error("Create a vault in Settings & vault first");
      const key = await CAPURNION_VAULT_KEYS.get(record);
      let opened = null;
      try {
        if (key) opened = await CAPURNION_VAULT.open(key, record);
        const latest = await current();
        if (latest?.revision !== record.revision) continue;
        if (!key) throw new Error("Unlock vault management once to enable automation access on this device");
        const entry = opened.data.entries.find(item => item.name === name);
        if (!entry) throw new Error("Secret not found in the vault");
        return entry.value;
      } finally {
        if (opened) { opened.data.entries.forEach(entry => { entry.value = ""; }); opened = null; }
      }
    }
    throw new Error("Vault changed during access; retry the automation");
  }
  globalThis.CAPURNION_VAULT_ACCESS = {status, getSecret};
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.CAPURNION_VAULT_ACCESS;
})();
