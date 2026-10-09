/* Deterministic Snowflake PAT renewal. No token secrets or private API calls. */
(() => {
  "use strict";
  const SECTION = '[data-testid="programmatic-access-tokens"]';
  const DIALOG = '[data-testid="bypass-network-policy-requirement-dialog"]';
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const text = el => normalize(el?.textContent);
  const validConfig = cfg => cfg?.enabled === true && cfg.confirmGrantsAccess === true &&
    /^https:\/\/app\.snowflake\.com\/[a-z0-9_-]+\/[a-z0-9_-]+\/settings\/authentication$/.test(cfg.url) &&
    cfg.intervalMinutes === 60 && (cfg.pollMinutes === undefined || cfg.pollMinutes === 5) &&
    (cfg.restoreMissingAccess === undefined || typeof cfg.restoreMissingAccess === "boolean") &&
    cfg.renewBelowMinutes === 120 && cfg.grantHours === 24 &&
    typeof cfg.expectedUser === "string" && !!cfg.expectedUser.trim();

  function remainingMinutes(value) {
    const label = normalize(value).toLowerCase();
    if (/^temporary access (?:has )?(?:expired|ended)$/.test(label)) return 0;
    const match = /^(?:(?:less than|<)\s+)?(\d+(?:\.\d+)?)\s+(seconds?|minutes?|hours?|days?)\s+left on temporary access$/.exec(label);
    if (!match) return null;
    const factors = {second: 1 / 60, minute: 1, hour: 60, day: 1440};
    const amount = Number(match[1]) * factors[match[2].replace(/s$/, "")];
    // A rounded "less than 2 hours" is strictly below the threshold.
    return /^(less than|<)/.test(label) ? Math.max(0, amount - 0.001) : amount;
  }

  function visible(el) {
    if (!el?.isConnected || el.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return !!el.getClientRects().length && style.display !== "none" && style.visibility !== "hidden";
  }
  const enabled = el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  function one(root, selector, predicate = visible) {
    const matches = [...root.querySelectorAll(selector)].filter(predicate);
    if (matches.length > 1) throw new Error(`Ambiguous control: ${selector}`);
    return matches[0] || null;
  }
  function scope(doc, cfg) {
    if (!validConfig(cfg) || doc.defaultView.location.href !== cfg.url)
      throw new Error("Account URL or grant authorization does not match configuration");
    const users = [...doc.querySelectorAll('[data-testid="user-context-menu-button"]')];
    if (users.length !== 1 || normalize(users[0].getAttribute("aria-label")) !== `Account Menu: ${cfg.expectedUser}`)
      throw new Error("Signed-in Snowflake user does not match configuration");
  }
  function rows(doc) {
    const root = one(doc, SECTION, el => el.isConnected);
    if (!root) return null;
    const active = one(root, '[role="radio"][aria-checked="true"]', el => el.isConnected);
    if (text(active) !== "Active") throw new Error("PAT list is not showing Active tokens");
    const result = [...root.querySelectorAll('[role="row"]')].map(row => {
      const nameNode = one(row, '[data-testid="name"]', el => el.isConnected);
      const name = text(nameNode);
      if (!name || name !== normalize(row.getAttribute("aria-label"))) throw new Error("Token row identity is ambiguous");
      const badge = one(row, '[data-testid="bypass-timer"]', el => el.isConnected);
      const expires = one(row, '[data-testid="expires-at"]', el => el.isConnected);
      return {row, name, expires: text(expires), temporaryAccess: text(badge), minutes: remainingMinutes(text(badge))};
    });
    if (new Set(result.map(item => item.name)).size !== result.length) throw new Error("Duplicate token names in PAT list");
    return result;
  }
  const metadata = item => ({name: item.name, expires: item.expires, temporaryAccess: item.temporaryAccess, minutes: item.minutes,
    bypassExpiresAt: item.minutes !== null ? Date.now() + item.minutes * 60000 : null,
    ...(item.recovered ? {recovered: true} : {})});

  async function run(doc, cfg, hooks = {}) {
    const timeoutMs = hooks.timeoutMs || 20000;
    const allow = hooks.allow || (async () => true);
    const report = {status: "ok", tokens: [], renewed: [], warnings: []};
    const readRows = () => {
      const items = rows(doc);
      if (!items) return null;
      const missingPolicy = /missing network policy/i.test(text(doc.querySelector('[data-testid="pat-network-policy-disclaimer"]')));
      for (const item of items) {
        const previous = (hooks.previousTokens || []).find(token => token.name === item.name && token.expires === item.expires);
        if (!item.temporaryAccess && (cfg.restoreMissingAccess === true ||
            (missingPolicy && Number.isFinite(previous?.bypassExpiresAt) &&
            previous.bypassExpiresAt > 0 && previous.bypassExpiresAt <= Date.now()))) {
          item.minutes = 0; item.recovered = true;
        }
      }
      return items;
    };
    const guard = async () => {
      if (!(await allow())) throw new Error("Check cancelled, paused, or background tab was activated");
      scope(doc, cfg);
    };
    const wait = predicate => new Promise((resolve, reject) => {
      const start = Date.now();
      let timer;
      const observer = new doc.defaultView.MutationObserver(check);
      function finish(error, value) {
        observer.disconnect();
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      }
      function check() {
        clearTimeout(timer);
        try {
          if (doc.defaultView.location.href !== cfg.url) throw new Error("Authentication page changed during renewal");
          const value = predicate();
          if (value) return finish(null, value);
          if (Date.now() - start >= timeoutMs) return finish(new Error("Timed out waiting for the expected Snowflake control or confirmation"));
          timer = setTimeout(check, 200);
        } catch (error) { finish(error); }
      }
      observer.observe(doc.documentElement, {subtree: true, childList: true, attributes: true, characterData: true});
      check();
    });
    const click = async el => {
      await guard();
      if (!enabled(el)) throw new Error("Expected control is not clickable");
      el.click();
    };
    const current = name => (readRows() || []).find(item => item.name === name);
    const visibleDialog = () => one(doc, DIALOG);
    try {
      await wait(() => {
        const items = readRows();
        const user = doc.querySelector('[data-testid="user-context-menu-button"]');
        return items && user ? items : null;
      });
      await guard();
      if (one(doc, '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
        throw new Error("Another dialog or menu is already open");
      const initial = readRows();
      report.tokens = initial.map(metadata);
      for (const item of initial) {
        if (item.temporaryAccess && item.minutes === null) report.warnings.push(`${item.name}: unrecognized temporary-access timer; skipped`);
      }
      const candidates = initial.filter(item => item.minutes !== null && item.minutes < cfg.renewBelowMinutes);
      for (const candidate of candidates) {
        await guard();
        const item = current(candidate.name);
        if (!item || item.expires !== candidate.expires) throw new Error("Token row changed before renewal");
        if (item.minutes === null || item.minutes >= cfg.renewBelowMinutes) continue;
        const menuButton = one(item.row, 'button[aria-label="More options"]');
        if (!menuButton) throw new Error(`${item.name}: More options button is missing`);
        await click(menuButton);
        const menuItem = await wait(() => one(doc, '[role="menuitem"]', el => enabled(el) &&
          text(el).toLowerCase() === "bypass requirement for network policy" && !!el.closest('[role="menu"]')));
        await click(menuItem);
        const dialog = await wait(visibleDialog);
        if (text(dialog.querySelector('[slot="title"], h2')).toLowerCase() !== "bypass network policy requirement")
          throw new Error("Unexpected bypass dialog title");
        const input = await wait(() => one(dialog, 'input[data-testid="bypass-amount"]', enabled));
        await guard();
        const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value").set;
        setter.call(input, String(cfg.grantHours));
        input.dispatchEvent(new doc.defaultView.Event("input", {bubbles: true}));
        input.dispatchEvent(new doc.defaultView.Event("change", {bubbles: true}));
        let unit = await wait(() => one(dialog, '[data-testid="bypass-unit-selector"]', enabled));
        if (text(unit) !== "Hours") {
          await click(unit);
          const hours = await wait(() => one(doc, '[role="option"]', el => enabled(el) && text(el) === "Hours" &&
            !!el.closest('[role="listbox"]')));
          await click(hours);
        }
        await wait(() => {
          unit = one(dialog, '[data-testid="bypass-unit-selector"]', enabled);
          return input.isConnected && input.value === "24" && text(unit) === "Hours";
        });
        const grant = await wait(() => one(dialog, '[data-testid="grant-access"]', enabled));
        await guard();
        const unchanged = current(candidate.name);
        const nativeSelect = dialog.querySelector('select');
        if (!unchanged || unchanged.expires !== candidate.expires || unchanged.minutes === null ||
            unchanged.minutes >= cfg.renewBelowMinutes || visibleDialog() !== dialog ||
            input.value !== "24" || text(unit) !== "Hours" || (nativeSelect && nativeSelect.value !== "60") ||
            text(grant).toLowerCase() !== "grant access")
          throw new Error("Token identity or 24 Hours grant settings changed before submission");
        // No asynchronous gap between the final form/identity checks and submit.
        if (!enabled(grant)) throw new Error("Grant access is no longer clickable");
        grant.click();
        const renewed = await wait(() => {
          if (visibleDialog()) return null;
          const updated = current(candidate.name);
          return updated && updated.expires === candidate.expires && updated.minutes >= 23 * 60 &&
            updated.minutes <= 24 * 60 ? updated : null;
        });
        report.renewed.push(candidate.name);
        report.tokens = (readRows() || []).map(metadata);
        await hooks.progress?.({...report});
        console.log(`[capurnion-pat] renewed ${renewed.name}: 24 Hours`);
      }
      if (report.warnings.length) report.status = "warning";
    } catch (error) {
      report.status = "error";
      report.error = error.message;
      console.warn(`[capurnion-pat] ${error.message}`);
    }
    return report;
  }

  const api = {validConfig, remainingMinutes, run};
  globalThis.CAPURNION_PAT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
