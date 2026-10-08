"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require(process.env.JSDOM_MODULE || "jsdom");
const flow = require("../okta-login-flow.js");

const doc = (html) =>
  new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;

// The real combined OIE sign-in page (email + password + Sign in).
const LOGIN = `
  <h1>Sign In</h1>
  <form>
    <label>Email Address</label>
    <input name="identifier" type="text" autocomplete="username">
    <label>Password</label>
    <input name="credentials.passcode" type="password" autocomplete="current-password">
    <div class="checkbox"><input name="rememberMe" type="checkbox"><label>Keep me signed in</label></div>
    <input type="submit" value="Sign in">
  </form>
`;

// Real factor list markup: descriptive aria-labels, plain "Select" text.
const FACTOR = `
  <h2>Verify it's you with a security method</h2>
  <p>Select from the following options</p>
  <a class="select-factor" aria-label="Select to enter a code from the Okta Verify app.">Select</a>
  <a class="select-factor" aria-label="Select to get a push notification to the Okta Verify app.">Select</a>
  <a class="select-factor" id="phone" aria-label="Select Phone - +1 XXX-XXX-XXXX.">Select</a>
  <a class="select-factor" aria-label="Select Security Key or Biometric Authenticator.">Select</a>
`;

const SEND_SMS = `
  <h2>Verify with your phone</h2>
  <p>Send a code via SMS to +1 XXX-XXX-XXXX.</p>
  <input type="submit" value="Receive a code via SMS">
  <a href="#">Receive a voice call instead</a>
`;

const CODE_ENTRY = `
  <h2>Verify with your phone</h2>
  <p>A code was sent to +1 XXX-XXX-XXXX. Enter the code below to verify.</p>
  <form>
    <label>Enter Code</label>
    <input name="credentials.passcode" type="text" autocomplete="off">
    <input type="submit" value="Verify">
  </form>
  <a href="#">Verify with something else</a>
`;

// Password step-up (no identifier). Must not be mistaken for login or code-entry.
const PASSWORD_ONLY = `
  <h2>Verify with your password</h2>
  <form>
    <input name="credentials.passcode" type="password">
    <input type="submit" value="Verify">
  </form>
`;

test("detects the combined login page", () => {
  const d = doc(LOGIN);
  assert.equal(flow.detectState(d), "login");
  const form = flow.loginForm(d);
  assert.ok(form);
  assert.equal(form.user.getAttribute("name"), "identifier");
  assert.equal(form.pass.getAttribute("type"), "password");
  assert.equal(form.submit.value, "Sign in");
});

test("password-only step-up is 'other', not login or code-entry", () => {
  const d = doc(PASSWORD_ONLY);
  assert.equal(flow.detectState(d), "other");
  assert.equal(flow.loginForm(d), null);
  assert.equal(flow.strictOtpInput(d), null);
});

test("detects factor-select and finds the Phone Select by aria-label", () => {
  const d = doc(FACTOR);
  assert.equal(flow.detectState(d), "factor-select");
  const btn = flow.phoneSelectButton(d);
  assert.ok(btn);
  assert.equal(btn.id, "phone");
});

test("detects send-sms and finds the button", () => {
  const d = doc(SEND_SMS);
  assert.equal(flow.detectState(d), "send-sms");
  assert.equal(flow.findClickableByText(d, /receive a code via sms/i).value, "Receive a code via SMS");
});

test("detects code-entry; Verify matches only the exact button", () => {
  const d = doc(CODE_ENTRY);
  assert.equal(flow.detectState(d), "code-entry");
  assert.equal(flow.otpInputForFill(d).getAttribute("name"), "credentials.passcode");
  assert.equal(flow.findClickableByText(d, /^\s*verify\s*$/i).value, "Verify");
});

test("dashboard / other pages are left alone", () => {
  assert.equal(flow.detectState(doc("<h1>Example Dashboard</h1><a>My Apps</a>")), "other");
});
