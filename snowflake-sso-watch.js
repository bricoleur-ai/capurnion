/* Extends configured SSO detection only in a PAT job's owned tab. */
(() => {
  "use strict";
  const M = globalThis.CAPURNION_MATCH, cfg = globalThis.CAPURNION_RULES;
  if (window !== window.top || !cfg?.snowflakePat?.enabled || !M ||
      !(location.hostname === "app.snowflake.com" || location.hostname.endsWith(".snowflakecomputing.com"))) return;
  const rules = (cfg.rules || []).filter(rule => rule.enabled && rule.kind === "idp-select" && M.hostListed(rule, location.hostname));
  if (!rules.length) return;
  // Let the unchanged SSO engine finish its first attempt before recovery starts.
  const readyAt = Date.now() + Math.max(15000, ...rules.map(rule => rule.options?.timeoutMs || 15000)) + 2000;
  let busy = false, done = false;
  function candidate() {
    const context = {host: location.hostname, url: location.href, pageText: document.body?.innerText || ""};
    for (const rule of rules) {
      if (M.blockers(rule, context).length) continue;
      const matches = [...document.querySelectorAll(rule.click.selector || M.DEFAULT_SELECTOR)].filter(el => {
        const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        const style = getComputedStyle(el);
        return M.safeRx(rule.click.label).test(label) && /okta|sso/i.test(label) && !el.disabled &&
          el.getAttribute("aria-disabled") !== "true" && !el.closest('[hidden], [aria-hidden="true"]') &&
          el.getClientRects().length && style.display !== "none" && style.visibility !== "hidden";
      });
      if (matches.length === 1) return {rule, element: matches[0]};
    }
    return null;
  }
  async function tick() {
    if (busy || done || Date.now() < readyAt) return;
    const before = candidate(); if (!before) return;
    busy = true;
    try {
      const reply = await chrome.runtime.sendMessage({type: "pat-sso-guard", ruleId: before.rule.id});
      const after = candidate();
      if (reply?.allowed && after?.element === before.element && after.rule.id === before.rule.id) {
        done = true; clearInterval(poll); before.element.click();
        console.log(`[capurnion-pat] recovered SSO button for rule ${before.rule.id}`);
      }
    } catch { /* A suspended worker or navigation will be retried on the next poll. */ }
    finally { busy = false; }
  }
  const poll = setInterval(tick, 5000);
  const deadline = setTimeout(() => { done = true; clearInterval(poll); }, 300000);
  window.addEventListener("pagehide", () => { clearInterval(poll); clearTimeout(deadline); }, {once: true});
})();
