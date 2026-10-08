/*
 * Capurnion engine -- generic and site-agnostic. You should never edit this
 * file to support a new site; add a rule to rules.json and run `capurnion sync`.
 *
 * Decisions about *whether* a rule fires live in matcher.js (shared with the
 * CLI). This file only does the browser-side work: watching the DOM, finding a
 * clickable element, and clicking it once.
 */
(() => {
  "use strict";

  const TAG = "[capurnion]";
  const CFG = globalThis.CAPURNION_RULES;
  const M = globalThis.CAPURNION_MATCH;

  if (!M) {
    console.error(`${TAG} matcher.js did not load -- run: capurnion sync`);
    return;
  }
  if (!CFG || !Array.isArray(CFG.rules)) {
    console.error(`${TAG} no rules loaded -- rules.generated.js is missing or stale. Run: capurnion sync`);
    return;
  }

  const DEFAULT_TIMEOUT_MS = 15000;
  const host = location.host;

  // Rules that name this host. Guards that depend on page content are re-checked
  // on every DOM change below, since a login SPA renders after document_idle.
  const scoped = CFG.rules.filter((r) => M.hostListed(r, host));
  if (!scoped.length) return;

  // Report anything permanently blocked once, at load, rather than staying quiet
  // about a rule that is never going to fire.
  const live = [];
  for (const rule of scoped) {
    const why = M.blockers(rule, { host, url: location.href, pageText: null });
    const structural = why.filter((w) => !w.includes("untested") && !w.includes("does not match"));
    if (structural.length) {
      console.warn(`${TAG} rule "${rule.id}" will not fire: ${structural.join("; ")}`);
      continue;
    }
    live.push(rule);
  }
  if (!live.length) return;
  console.log(`${TAG} armed on ${host}: ${live.map((r) => r.id).join(", ")}`);

  const isClickable = (el) => {
    if (el.disabled === true) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none";
  };

  const labelOf = (el) =>
    (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim();

  let done = false;
  let observer = null;

  const attempt = () => {
    if (done) return;
    const pageText = document.body ? document.body.innerText : "";
    const ctx = { host, url: location.href, pageText };

    for (const rule of live) {
      if (M.blockers(rule, ctx).length) continue;

      const selector = (rule.click && rule.click.selector) || M.DEFAULT_SELECTOR;
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (e) {
        console.error(`${TAG} rule "${rule.id}": click.selector is invalid (${selector})`);
        continue;
      }

      const labelRx = M.safeRx(rule.click.label);
      for (const el of nodes) {
        if (!labelRx.test(labelOf(el))) continue;
        if (!isClickable(el)) continue;

        done = true;
        if (observer) observer.disconnect();

        const fire = () => {
          if (!isClickable(el)) {
            console.warn(`${TAG} rule "${rule.id}": target stopped being clickable during delayMs -- not clicking`);
            return;
          }
          el.click();
          console.log(
            `${TAG} clicked rule="${rule.id}" kind=${rule.kind} label=${JSON.stringify(labelOf(el).slice(0, 80))}`
          );
        };
        const delay = (rule.options && rule.options.delayMs) || 0;
        if (delay > 0) setTimeout(fire, delay);
        else fire();
        return;
      }
    }
  };

  // Watch until the button appears, but stop eventually rather than observing
  // forever on a page where it never does.
  const timeoutMs = Math.max(
    ...live.map((r) => (r.options && r.options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  );
  observer = new MutationObserver(attempt);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  setTimeout(() => {
    if (done) return;
    done = true;
    observer.disconnect();
    console.log(`${TAG} no match within ${timeoutMs}ms on ${host} -- stopped watching`);
  }, timeoutMs);

  attempt();
})();
