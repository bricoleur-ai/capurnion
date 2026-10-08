/* Drives the Okta login + SMS flow on the configured Okta host, using the pure
 * helpers in okta-login-flow.js. It never holds secrets at rest: it asks
 * okta-login-background.js (trusted context) for the vaulted username/password
 * and the 2fu SMS code only at the moment each field is filled.
 *
 * Takes one safe action per screen:
 *   login         -> fill email + password (from the vault) and Sign in
 *   factor-select -> click "Select" on the Phone row
 *   send-sms      -> click "Receive a code via SMS"
 *   code-entry    -> poll 2fu for the code, fill it, Verify
 *
 * Never touches password-less step-up or push/approve screens. Toggle the
 * extension off at chrome://extensions to sign in by hand. */
(() => {
  "use strict";
  if (globalThis.CAPURNION_OKTA_CONTENT) return;
  globalThis.CAPURNION_OKTA_CONTENT = true;

  const cfg = globalThis.CAPURNION_RULES?.oktaLogin;
  const flow = globalThis.CAPURNION_OKTA_FLOW;
  if (!cfg?.enabled || cfg.confirmAutomatesMfa !== true || !flow) return;
  if (window !== window.top || location.hostname !== cfg.host) return;

  const TAG = "[capurnion-okta]";
  const POLL_MS = 3000;
  const MAX_WAIT_MS = 120000;
  const log = (...a) => console.log(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const done = { login: false, factor: false, sms: false, fill: false };

  async function ask(type) {
    try {
      const resp = await chrome.runtime.sendMessage({ type });
      return resp && resp.ok ? resp : null;
    } catch (_e) {
      return null;
    }
  }

  function setInputValue(input, value) {
    const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    input.focus();
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function doLogin(form) {
    if (done.login) return;
    done.login = true;
    const creds = await ask("okta-creds");
    if (!creds) {
      done.login = false;
      log("could not get credentials from the vault (create/unlock it once in Settings & vault)");
      return;
    }
    setInputValue(form.user, creds.username);
    setInputValue(form.pass, creds.password);
    log("filled credentials; signing in");
    form.submit.click();
  }

  async function fillCode() {
    if (done.fill) return;
    done.fill = true;
    log("code-entry screen; polling 2fu for the SMS code");
    const deadline = Date.now() + MAX_WAIT_MS;
    let code = null;
    while (Date.now() < deadline) {
      const resp = await ask("okta-otp");
      if (resp && resp.code) {
        code = resp.code;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!code) {
      done.fill = false;
      log("no code from 2fu within timeout");
      return;
    }
    const input = flow.otpInputForFill(document);
    if (!input) {
      done.fill = false;
      log("code arrived but no OTP input found");
      return;
    }
    setInputValue(input, code);
    const verify =
      flow.findClickableByText(document, /^\s*verify\s*$/i) ||
      (input.form && input.form.querySelector('input[type="submit"], button[type="submit"]'));
    log("filled code; submitting");
    if (verify) verify.click();
  }

  function tick() {
    let state;
    try {
      state = flow.detectState(document);
    } catch (_e) {
      return;
    }
    if (state === "login" && !done.login) {
      const form = flow.loginForm(document);
      if (form) doLogin(form);
    } else if (state === "factor-select" && !done.factor) {
      const b = flow.phoneSelectButton(document);
      if (b) {
        done.factor = true;
        log("selecting the Phone factor");
        b.click();
      }
    } else if (state === "send-sms" && !done.sms) {
      const b = flow.findClickableByText(document, /receive a code via sms/i);
      if (b) {
        done.sms = true;
        log("requesting the SMS code");
        b.click();
      }
    } else if (state === "code-entry" && !done.fill) {
      fillCode();
    }
  }

  const observer = new MutationObserver(tick);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  tick();
  log("armed on", location.host);
})();
