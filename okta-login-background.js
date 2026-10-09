/* Trusted context. Serves the Okta content script its vaulted username/password
 * and the 2fu SMS code. This is the "explicitly configured automation" the vault
 * docs require for credential filling: it answers only okta-creds / okta-otp.
 * It decrypts the two named secrets with the device key, whether or not the panel
 * is unlocked (the panel also decrypts while management is unlocked), and hands them
 * only to capurnion's top-frame content script on the configured Okta host, which
 * types them into the page's form. */
"use strict";
(() => {
  const cfg = globalThis.CAPURNION_RULES?.oktaLogin;
  if (!cfg?.enabled || cfg.confirmAutomatesMfa !== true) return;

  function trustedSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0) return false;
    try {
      return new URL(sender.url).hostname === cfg.host;
    } catch {
      return false;
    }
  }

  async function creds() {
    const vault = globalThis.CAPURNION_VAULT_ACCESS;
    if (!vault) return { ok: false, error: "vault-unavailable" };
    const username = await vault.getSecret(cfg.usernameSecret || "ou");
    const password = await vault.getSecret(cfg.passwordSecret || "op");
    return { ok: true, username, password };
  }

  async function otp() {
    const resp = await fetch(cfg.smsCodeUrl, { cache: "no-store" });
    if (resp.status === 200) {
      const data = await resp.json().catch(() => ({}));
      return { ok: true, code: data && data.code ? String(data.code) : null };
    }
    return { ok: true, code: null, status: resp.status };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const type = message?.type;
    if (type !== "okta-creds" && type !== "okta-otp") return;
    if (!trustedSender(sender)) {
      respond({ ok: false, error: "untrusted" });
      return true;
    }
    (type === "okta-creds" ? creds() : otp()).then(respond, (error) =>
      respond({ ok: false, error: String((error && error.message) || error) })
    );
    return true; // async response
  });
})();
