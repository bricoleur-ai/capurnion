"use strict";
const VAULT_KEY = "capurnionEncryptedVault";
const byId = id => document.getElementById(id);
const config = globalThis.CAPURNION_RULES || {};
let record = null, key = null, data = null, editing = null, busy = false, epoch = 0, idleTimer;
const storage = chrome.storage.local;
function status(message) { byId("vault-status").textContent = message; }
async function refreshAutomation() {
  try {
    const result = await CAPURNION_VAULT_ACCESS.status();
    byId("automation-status").textContent = result.ready ? "Automation access: available, even with management locked" :
      result.reason === "no-vault" ? "Automation access: create a vault first" : "Automation access: unlock management once to enable it";
  } catch { byId("automation-status").textContent = "Automation access: unavailable; unlock management to restore the device key"; }
}
function clearEdit() {
  editing = null;
  byId("secret-form").reset();
  byId("secret-title").textContent = "Add a secret";
  byId("cancel-edit").hidden = true;
}
function renderMode() {
  byId("unlock-form").hidden = !!key;
  byId("unlocked").hidden = !key;
  byId("lock").hidden = !key;
  byId("confirm-row").hidden = !!record;
  byId("create-note").hidden = !!record;
  byId("confirm").required = !record;
  byId("passphrase").autocomplete = record ? "current-password" : "new-password";
  byId("unlock").textContent = record ? "Unlock management" : "Create vault";
}
function touch() {
  clearTimeout(idleTimer);
  if (key) idleTimer = setTimeout(() => lock("Management locked after five minutes without activity"), 300000);
}
function lock(message = "Management locked") {
  epoch++;
  key = null; data = null;
  clearTimeout(idleTimer);
  document.querySelectorAll('#vault input').forEach(input => { input.value = ""; });
  byId("entries").replaceChildren();
  byId("password-form").reset();
  clearEdit(); renderMode(); status(message);
}
function renderEntries() {
  const entries = byId("entries"); entries.replaceChildren();
  if (!data.entries.length) {
    const empty = document.createElement("p"); empty.textContent = "No secrets saved yet."; entries.append(empty);
  }
  for (const entry of data.entries) {
    const row = document.createElement("div"); row.className = "entry";
    const heading = document.createElement("h3"); heading.textContent = entry.name;
    const value = document.createElement("input"); value.type = "password"; value.readOnly = true;
    value.value = entry.value; value.setAttribute("aria-label", `${entry.name} secret value`); value.autocomplete = "off";
    const buttons = document.createElement("div"); buttons.className = "buttons";
    const reveal = document.createElement("button"); reveal.type = "button"; reveal.textContent = "Reveal";
    reveal.addEventListener("click", () => { value.type = value.type === "password" ? "text" : "password"; reveal.textContent = value.type === "password" ? "Reveal" : "Hide"; });
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editing = entry.id; byId("secret-name").value = entry.name; byId("secret-value").value = entry.value;
      byId("secret-title").textContent = "Edit secret"; byId("cancel-edit").hidden = false; byId("secret-name").focus();
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      if (confirm(`Delete the secret “${entry.name}”?`)) act(async () => {
        await saveState({entries: data.entries.filter(item => item.id !== entry.id)});
        clearEdit(); status("Secret deleted");
      });
    });
    buttons.append(reveal, edit, remove); row.append(heading, value, buttons); entries.append(row);
  }
}
function checkEpoch(expected) {
  if (epoch !== expected) throw new Error("Management was locked; unlock it again");
}
async function commit(next, expectedRevision, expectedEpoch) {
  return navigator.locks.request("capurnion-vault-write", async () => {
    checkEpoch(expectedEpoch);
    const current = (await storage.get(VAULT_KEY))[VAULT_KEY];
    if ((current?.revision || null) !== expectedRevision) {
      lock("Vault changed in another panel. Unlock it again.");
      record = current || null; renderMode();
      throw new Error("Vault changed in another panel; your changes were not saved");
    }
    checkEpoch(expectedEpoch);
    // Persist the non-exportable key first. A failed ciphertext write leaves the
    // previous record's key intact. Nothing stores the management passphrase.
    await CAPURNION_VAULT_KEYS.put(next.record, next.key);
    checkEpoch(expectedEpoch);
    await storage.set({[VAULT_KEY]: next.record});
    checkEpoch(expectedEpoch);
    // Cleanup is optional; failure must not misreport a committed save as failed.
    await CAPURNION_VAULT_KEYS.prune(next.record).catch(() => {});
    checkEpoch(expectedEpoch);
    record = next.record; key = next.key; data = next.data;
    renderMode(); renderEntries(); touch(); await refreshAutomation();
  });
}
async function saveState(nextData, passphrase) {
  if (!key) throw new Error("Unlock management first");
  const expectedEpoch = epoch, expectedRevision = record.revision, currentKey = key;
  const next = passphrase === undefined ? {key: currentKey, data: nextData,
    record: await CAPURNION_VAULT.seal(currentKey, nextData, record.kdf)} : await CAPURNION_VAULT.create(passphrase, nextData);
  checkEpoch(expectedEpoch);
  await commit(next, expectedRevision, expectedEpoch);
}
async function act(operation) {
  if (busy) return;
  byId("error").textContent = "";
  if (!config.vault?.enabled) { byId("error").textContent = "Vault is disabled in rules.json"; return; }
  busy = true; document.querySelectorAll('#vault button').forEach(button => { button.disabled = true; });
  try { await operation(); }
  catch (error) { byId("error").textContent = error.message; }
  finally { busy = false; document.querySelectorAll('#vault button').forEach(button => { button.disabled = false; }); }
}
byId("unlock-form").addEventListener("submit", event => {
  event.preventDefault();
  act(async () => {
    const expectedEpoch = epoch, expectedRevision = record?.revision || null;
    const passphrase = byId("passphrase").value, confirmation = byId("confirm").value;
    byId("passphrase").value = ""; byId("confirm").value = "";
    if (!record) {
      if (passphrase !== confirmation) throw new Error("Passphrases do not match");
      const next = await CAPURNION_VAULT.create(passphrase);
      checkEpoch(expectedEpoch); await commit(next, expectedRevision, expectedEpoch); status("Vault created; management unlocked");
    } else {
      const opened = await CAPURNION_VAULT.unlock(passphrase, record);
      checkEpoch(expectedEpoch);
      // Existing vaults gain persistent automation access on their first unlock.
      await commit({...opened, record}, expectedRevision, expectedEpoch); status("Management unlocked");
    }
  });
});
byId("secret-form").addEventListener("submit", event => {
  event.preventDefault();
  act(async () => {
    if (!key) throw new Error("Unlock management first");
    const name = byId("secret-name").value.trim(), value = byId("secret-value").value;
    if (!name || !value) throw new Error("Enter a name and secret value");
    if (data.entries.some(entry => entry.name === name && entry.id !== editing)) throw new Error("A secret with this name already exists");
    const entry = {id: editing || crypto.randomUUID(), name, value, updatedAt: Date.now()};
    const entries = editing ? data.entries.map(item => item.id === editing ? entry : item) : [...data.entries, entry];
    await saveState({entries}); clearEdit(); status("Secret saved");
  });
});
byId("password-form").addEventListener("submit", event => {
  event.preventDefault();
  act(async () => {
    const passphrase = byId("new-passphrase").value, confirmation = byId("new-confirm").value;
    byId("password-form").reset();
    if (passphrase !== confirmation) throw new Error("Passphrases do not match");
    await saveState(data, passphrase); status("Management passphrase changed");
  });
});
byId("cancel-edit").addEventListener("click", clearEdit);
byId("lock").addEventListener("click", () => lock());
window.addEventListener("pagehide", () => lock());
window.addEventListener("pageshow", event => { if (event.persisted) lock(); });
window.addEventListener("pointerdown", touch); window.addEventListener("keydown", touch);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(VAULT_KEY in changes) || busy) return;
  if (key && changes[VAULT_KEY].newValue?.revision !== record?.revision) lock("Vault changed in another panel. Unlock it again.");
  record = changes[VAULT_KEY].newValue || null; renderMode();
  refreshAutomation();
});

let patPaused = false;
async function refreshPat() {
  const result = await chrome.runtime.sendMessage({type: "pat-status"});
  if (result?.error) throw new Error(result.error);
  patPaused = result.paused;
  const status = result.status || {};
  byId("pat-status").textContent = patPaused ? "Paused" : status.status === "checking" ? (status.phase === "okta" ? "Restoring Okta sign-in…" : "Checking Snowflake…") :
    status.error || (status.checkedAt ? `Last check: ${new Date(status.checkedAt).toLocaleString()}` : "Waiting for the first check");
  if (result.okta && !patPaused) byId("pat-status").textContent += ` · Okta: ${{active: "signed in", "signed-out": "signed out", unknown: "could not verify"}[result.okta.state] || result.okta.state}`;
  if (status.status === "checking" && status.step) byId("pat-status").textContent += ` · ${status.step}`;
  byId("pat-check").disabled = patPaused || status.status === "checking";
  byId("pat-pause").textContent = patPaused ? "Resume" : "Pause";
}
for (const [id, type] of [["pat-check", "pat-check-now"], ["pat-pause", "pat-pause"]])
  byId(id).addEventListener("click", async () => {
    try { await chrome.runtime.sendMessage({type, paused: !patPaused}); await refreshPat(); }
    catch (error) { byId("error").textContent = error.message; }
  });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && config.snowflakePat?.enabled && (changes.patStatus || changes.patPaused))
    refreshPat().catch(error => { byId("error").textContent = error.message; });
});
(async () => {
  if (!config.vault?.enabled) { status("Vault is disabled in rules.json"); return; }
  await storage.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  record = (await storage.get(VAULT_KEY))[VAULT_KEY] || null;
  renderMode(); status(record ? "Management locked" : "Create your local encrypted vault"); await refreshAutomation();
  if (config.snowflakePat?.enabled) {
    byId("pat").hidden = false; byId("pat-settings").href = config.snowflakePat.url; await refreshPat();
  }
})().catch(error => { byId("error").textContent = error.message; });
