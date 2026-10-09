"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fixture = require("./pat-fixture.js");
const api = require("../snowflake-pat.js");
const URL = "https://app.snowflake.com/testorg/testaccount/settings/authentication";
const cfg = {enabled: true, confirmGrantsAccess: true, url: URL, expectedUser: "test-user", intervalMinutes: 60, renewBelowMinutes: 120, grantHours: 24};
let browser;
const ready = (async () => {
  if (process.env.JSDOM_MODULE) {
    const {JSDOM} = require(process.env.JSDOM_MODULE);
    const windows = [];
    console.log("Workflow checks use jsdom; layout is simulated, not a live Chrome session.");
    browser = {
      async close() { windows.forEach(window => window.close()); },
      async newPage() {
        let html, dom;
        return {
          async route(pattern, callback) { await callback({fulfill: ({body}) => { html = body; }}); },
          async goto(url) {
            dom = new JSDOM(html, {url, runScripts: "dangerously", pretendToBeVisual: true});
            windows.push(dom.window);
            Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
              get() { return this.textContent; }, set(value) { this.textContent = value; }, configurable: true,
            });
            dom.window.Element.prototype.getClientRects = function () {
              for (let el = this; el; el = el.parentElement) {
                if (el.hidden || dom.window.getComputedStyle(el).display === "none") return [];
              }
              return this.isConnected ? [{width: 100, height: 20}] : [];
            };
          },
          async addScriptTag({path}) { dom.window.eval(fs.readFileSync(path, "utf8")); },
          async evaluate(fn, data) {
            const result = await dom.window.eval(`(${fn})(${JSON.stringify(data)})`);
            return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          },
          async close() { dom.window.close(); },
        };
      },
    };
  } else {
    const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
  }
})();
async function run(options = {}, config = cfg, otherUrl = URL) {
  await ready;
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({contentType: "text/html", body: fixture(options)}));
  await page.goto(otherUrl);
  await page.addScriptTag({path: path.join(__dirname, "../snowflake-pat.js")});
  const result = await page.evaluate(async ({config, cancelAfter, previousTokens}) => {
    let guards = 0;
    const report = await CAPURNION_PAT.run(document, config, {timeoutMs: 400, previousTokens,
      allow: async () => !cancelAfter || ++guards < cancelAfter});
    return {report, grants: window.grants, menuClicks: window.menuClicks};
  }, {config, cancelAfter: options.cancelAfter, previousTokens: options.previousTokens});
  await page.close();
  return result;
}
test("timer parsing and strict two-hour boundary", () => {
  assert.equal(api.remainingMinutes("23 hours left on temporary access"), 1380);
  assert.equal(api.remainingMinutes("1 hour left on temporary access"), 60);
  assert.equal(api.remainingMinutes("119 minutes left on temporary access"), 119);
  assert.equal(api.remainingMinutes("2 hours left on temporary access"), 120);
  assert(api.remainingMinutes("less than 2 hours left on temporary access") < 120);
  assert.equal(api.remainingMinutes("Missing network policy"), null);
  assert.equal(api.remainingMinutes("Expires on Jan 5, 2027"), null);
  assert.equal(api.remainingMinutes("Temporary access has expired"), 0);
});
test("recovers a lapsed Active token with no badge through its own kebab menu", async () => {
  const result = await run({rows: [{name: "lapsed", timer: ""}], minutes: true}, {...cfg, restoreMissingAccess: true});
  assert.equal(result.report.status, "ok", result.report.error);
  assert.deepEqual(result.menuClicks, ["lapsed"]);
  assert.deepEqual(result.grants, [{name: "lapsed", amount: "24", unit: "Hours"}]);
  assert.deepEqual(result.report.renewed, ["lapsed"]);
  assert.equal(result.report.tokens[0].expires, "Expires on Jan 5, 2027");
  assert(result.report.tokens[0].bypassExpiresAt > Date.now() + 22 * 60 * 60000);
});
test("recovers vanished timer from an elapsed, matching window history", async () => {
  const result = await run({rows: [{name: "lapsed", timer: ""}], previousTokens: [{name: "lapsed", expires: "Expires on Jan 5, 2027", bypassExpiresAt: Date.now() - 1000}]});
  assert.equal(result.report.status, "ok"); assert.deepEqual(result.report.renewed, ["lapsed"]);
});
test("no-badge recovery still rejects unknown badges, changed menu, and wrong user", async () => {
  const config = {...cfg, restoreMissingAccess: true};
  const unknown = await run({rows: [{name: "unknown", timer: "Temporary access unavailable"}]}, config);
  assert.equal(unknown.report.status, "warning"); assert.deepEqual(unknown.grants, []);
  for (const [options, c] of [[{wrongMenu: true}, config], [{}, {...config, expectedUser: "other-user"}]]) {
    const result = await run({...options, rows: [{name: "lapsed", timer: ""}]}, c);
    assert.equal(result.report.status, "error"); assert.deepEqual(result.grants, []);
  }
});
test("empty Active list completes without a timeout", async () => {
  const result = await run({rows: []}); assert.equal(result.report.status, "ok"); assert.deepEqual(result.grants, []);
});
test("renews each due row once, skips two-hour boundary and healthy/no-bypass rows", async () => {
  const result = await run();
  assert.equal(result.report.status, "ok", result.report.error);
  assert.deepEqual(result.grants, [{name: "due-one", amount: "24", unit: "Hours"}, {name: "due-two", amount: "24", unit: "Hours"}]);
  assert.deepEqual(result.report.renewed, ["due-one", "due-two"]);
});
test("selects Hours when the modal initially shows Minutes", async () => {
  const result = await run({minutes: true});
  assert.equal(result.report.status, "ok", result.report.error);
  assert(result.grants.every(grant => grant.amount === "24" && grant.unit === "Hours"));
});
for (const [name, options, config, url] of [
  ["wrong account", {}, cfg, URL.replace("testaccount", "anotheraccount")],
  ["wrong user", {}, {...cfg, expectedUser: "different-user"}],
  ["missing authorization", {}, {...cfg, confirmGrantsAccess: false}],
  ["expired token list", {expired: true}],
  ["unrelated open dialog", {otherDialog: true}],
  ["changed menu label", {wrongMenu: true}],
  ["rejected amount", {rejectInput: true}],
  ["disabled grant button", {disableGrant: true}],
  ["changed token identity", {changeToken: true}],
  ["paused mid-workflow", {cancelAfter: 5}],
  ["duplicate row identities", {rows: [{name: "same", timer: "1 hour left on temporary access"}, {name: "same", timer: "1 hour left on temporary access"}]}],
]) {
  test(`does not grant for ${name}`, async () => {
    const result = await run(options, config || cfg, url || URL);
    assert.equal(result.report.status, "error");
    assert.deepEqual(result.grants, []);
  });
}
test("unknown timers are skipped and reported", async () => {
  const result = await run({rows: [{name: "unknown", timer: "Temporary access unavailable"}]});
  assert.equal(result.report.status, "warning");
  assert.deepEqual(result.grants, []);
});
test("a submitted grant is not reported successful without a changed timer", async () => {
  const result = await run({noConfirmation: true});
  assert.equal(result.grants.length, 1);
  assert.equal(result.report.status, "error");
  assert.deepEqual(result.report.renewed, []);
});
test("existing SSO engine runs before PAT content announces readiness", async () => {
  await ready;
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({contentType: "text/html", body: fixture({loginFirst: true})}));
  await page.goto(URL);
  await page.evaluate(config => {
    window.messages = [];
    window.chrome = {runtime: {id: "test-extension", onMessage: {addListener() {}},
      async sendMessage(message) { messages.push(message); return {}; }}};
    window.CAPURNION_RULES = {snowflakePat: config, rules: [{id: "test-okta", enabled: true,
      kind: "idp-select", hosts: [location.host], require: {url: "settings/authentication"}, click: {label: "^sign in with okta$"}}]};
  }, cfg);
  for (const file of ["matcher.js", "engine.js", "snowflake-pat.js", "snowflake-pat-content.js"])
    await page.addScriptTag({path: path.join(__dirname, "..", file)});
  assert.equal(await page.evaluate(() => oktaClicks), 1);
  assert.equal(await page.evaluate(() => messages.length), 0);
  await page.evaluate(async () => { finishLogin(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(await page.evaluate(() => messages.map(message => message.type)), ["pat-ready"]);
  await page.close();
});
test("close workflow test browser", async () => { await ready; await browser.close(); });
