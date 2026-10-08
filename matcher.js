/*
 * Capurnion matcher -- the single source of truth for "would this rule fire?".
 *
 * Loaded two ways on purpose, so there is exactly one implementation:
 *   - as a content script, alongside engine.js in the browser
 *   - via require() from bin/evaluate.js, which is what `capurnion test` calls
 * If you change matching semantics, they change in both places at once.
 */
(() => {
  "use strict";

  const DEFAULT_SELECTOR =
    'button, a, [role="button"], input[type="submit"], input[type="button"]';

  // Safety tiers.
  //   idp-select       choosing an identity provider. Navigational, grants nothing.
  //   session-continue clicking past a "Continue as <user>" interstitial.
  //   consent-grant    approving an OAuth scope request. This GRANTS ACCESS, so a
  //                    rule must opt in with "confirmGrantsAccess": true.
  // MFA "Approve" is deliberately not a tier: it is indistinguishable from a
  // consent button here, and auto-clicking it cancels out the second factor.
  const TIER_ALLOWED = {
    "idp-select": () => true,
    "session-continue": () => true,
    "consent-grant": (rule) => rule.confirmGrantsAccess === true,
  };

  const hostMatches = (pattern, host) => {
    if (pattern === host) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith("." + suffix);
    }
    return false;
  };

  const safeRx = (src) => {
    try {
      return new RegExp(src, "i");
    } catch (e) {
      return null;
    }
  };

  const hostListed = (rule, host) =>
    Array.isArray(rule.hosts) && rule.hosts.some((h) => hostMatches(h, host));

  /* Why a rule will not fire, as a list of human-readable reasons.
     ctx: { host, url, pageText }. pageText === null means "not known here",
     which is reported as untested rather than silently treated as a pass. */
  const blockers = (rule, ctx) => {
    const out = [];
    if (rule.enabled !== true) out.push("rule is disabled");
    if (!hostListed(rule, ctx.host)) out.push("host is not in the rule's hosts list");

    const gate = TIER_ALLOWED[rule.kind];
    if (!gate) out.push(`unknown kind "${rule.kind}"`);
    else if (!gate(rule)) out.push("kind=consent-grant without \"confirmGrantsAccess\": true");

    const click = rule.click || {};
    if (typeof click.label !== "string") out.push("click.label is missing");
    else if (!safeRx(click.label)) out.push(`click.label is not a valid regex (${click.label})`);

    const req = rule.require || {};
    if (req.url) {
      const rx = safeRx(req.url);
      if (!rx) out.push(`require.url is not a valid regex (${req.url})`);
      else if (!rx.test(ctx.url || "")) out.push(`require.url /${req.url}/i does not match the URL`);
    }
    if (req.pageText) {
      const rx = safeRx(req.pageText);
      if (!rx) out.push(`require.pageText is not a valid regex (${req.pageText})`);
      else if (ctx.pageText === null || ctx.pageText === undefined)
        out.push(`require.pageText /${req.pageText}/i untested (no page text supplied)`);
      else if (!rx.test(ctx.pageText))
        out.push(`require.pageText /${req.pageText}/i does not match the page text`);
    }
    return out;
  };

  const api = { DEFAULT_SELECTOR, TIER_ALLOWED, hostMatches, hostListed, safeRx, blockers };
  if (typeof globalThis !== "undefined") globalThis.CAPURNION_MATCH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
