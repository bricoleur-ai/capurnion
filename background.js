"use strict";
importScripts("rules.generated.js");
if (globalThis.CAPURNION_RULES?.vault?.enabled) {
  importScripts("vault.js", "vault-device-key.js", "vault-runtime.js");
  chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}
if (globalThis.CAPURNION_RULES?.snowflakePat?.enabled)
  importScripts("snowflake-pat-background.js");
// After the vault import above, so CAPURNION_VAULT_ACCESS is available to it.
if (globalThis.CAPURNION_RULES?.oktaLogin?.enabled)
  importScripts("okta-login-background.js");
