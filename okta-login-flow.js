/* Pure DOM logic for the Okta Identity Engine login + SMS flow.
 *
 * No chrome.*, no timers, no secrets -- so it unit-tests under jsdom and stays
 * auditable. okta-login-content.js wires these to a MutationObserver and asks
 * okta-login-background.js (trusted context) for the vaulted credentials and the
 * 2fu SMS code. Loaded as a content script before okta-login-content.js (shared
 * scope); also exported for node tests at the bottom. */
(() => {
  "use strict";

  // Prefer on-screen text, then input value, then aria-label. (Okta's factor
  // "Select" links carry descriptive aria-labels like "Select Phone - …", so
  // aria-label must come last or it swallows the plain "Select" text match.)
  function elementText(el) {
    return (el.innerText != null && el.innerText !== "" ? el.innerText : el.textContent) || "";
  }
  function visibleLabel(el) {
    return (elementText(el) || el.value || el.getAttribute("aria-label") || "").trim();
  }

  function findClickableByText(root, re) {
    const els = root.querySelectorAll(
      'button, a, input[type="submit"], input[type="button"], [role="button"]'
    );
    for (const el of els) if (re.test(visibleLabel(el))) return el;
    return null;
  }

  // The OIE OTP field. OIE reuses name="credentials.passcode" for the PASSWORD
  // field too, so exclude password/hidden inputs. Must never match a password box.
  function strictOtpInput(root) {
    return (
      root.querySelector('input[autocomplete="one-time-code"]') ||
      root.querySelector('input[name="credentials.passcode"]:not([type="password"]):not([type="hidden"])') ||
      root.querySelector('input[name="answer"]')
    );
  }
  function otpInputForFill(root) {
    return (
      strictOtpInput(root) ||
      root.querySelector('form input[type="tel"]:not([disabled])') ||
      root.querySelector('form input[type="text"]:not([disabled]):not([name="identifier"])')
    );
  }

  // The "Select" control on the Phone row of the factor list. Never the
  // push/Okta-Verify option. Okta labels it with a naming aria-label.
  function phoneSelectButton(root) {
    const clickables = Array.from(
      root.querySelectorAll('a, button, input[type="submit"], [role="button"]')
    );
    for (const el of clickables) {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      if (/select/.test(aria) && /\bphone\b/.test(aria)) return el;
    }
    const selects = clickables.filter((e) => /^\s*select\s*$/i.test(visibleLabel(e)));
    for (const sel of selects) {
      let node = sel;
      for (let i = 0; i < 3 && node; i++) {
        const t = elementText(node).toLowerCase();
        if (/\bphone\b/.test(t) && !/okta verify|password|security (question|key)/.test(t)) return sel;
        node = node.parentElement;
      }
    }
    return null;
  }

  // The combined Okta sign-in page: email + password + Sign in, before any MFA.
  function loginForm(root) {
    const user = root.querySelector('input[name="identifier"]');
    const pass = root.querySelector('input[name="credentials.passcode"][type="password"]');
    const submit = findClickableByText(root, /^\s*sign in\s*$/i);
    return user && pass && submit ? { user, pass, submit } : null;
  }

  // Classify the current Okta screen. Only login + the SMS path are handled;
  // password-less step-up, push/approve, and the dashboard are "other".
  function detectState(doc) {
    const text = doc.body ? elementText(doc.body) : "";
    const low = text.toLowerCase();
    if (loginForm(doc)) return "login";
    const smsContext = /a code was sent|enter code|verify with your phone/i.test(text);
    if ((strictOtpInput(doc) && smsContext) || /a code was sent|enter code/i.test(text)) return "code-entry";
    if (/receive a code via sms|send a code via sms/i.test(text)) return "send-sms";
    if ((/select .*following/.test(low) || /security method/.test(low)) && phoneSelectButton(doc)) return "factor-select";
    return "other";
  }

  const api = {
    elementText,
    visibleLabel,
    findClickableByText,
    strictOtpInput,
    otpInputForFill,
    phoneSelectButton,
    loginForm,
    detectState,
  };
  globalThis.CAPURNION_OKTA_FLOW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
