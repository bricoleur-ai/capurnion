(() => {
  /*
   * Capurnion page probe.
   *
   * Run this in the tab that is sitting on the login page you want to automate --
   * e.g. Claude in Chrome's javascript_tool, or paste it into DevTools. It reads
   * the page and returns the everything needed to write a rule: the host, the
   * headings you could guard on, and every clickable label, with SSO-looking ones
   * sorted first.
   *
   * It only reads. It clicks nothing and types nothing.
   *
   * Feed the JSON it returns to:  capurnion draft --from probe.json
   */

  // NOTE: the opening `(` must stay on line 1. Evaluators commonly run this as
  // `return <file contents>`; a leading comment would trigger ASI and return undefined.
  const MAX_CANDIDATES = 40;
  const SELECTOR =
    'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]';

  const labelOf = (el) =>
    (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "")
      .replace(/\s+/g, " ")
      .trim();

  const isVisible = (el) => {
    if (el.disabled === true) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none";
  };

  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Heuristic only -- it sorts the list, it does not decide anything.
  const ssoLike = (label) =>
    /\bsso\b|\bokta\b|\bsaml\b|\bsingle sign.?on\b|\bidp\b/i.test(label) ||
    /\b(sign ?in|log ?in|continue|authenticate)\b[^.]{0,20}\b(with|using|via)\b/i.test(label);

  const seen = new Set();
  const candidates = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const label = labelOf(el);
    if (!label || label.length > 120) continue;
    const key = label.toLowerCase() + "|" + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      label,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      ssoLike: ssoLike(label),
      labelRegex: "^" + escapeRx(label.toLowerCase()) + "$",
    });
  }
  candidates.sort(
    (a, b) => Number(b.ssoLike) - Number(a.ssoLike) || Number(b.visible) - Number(a.visible)
  );
  candidates.forEach((c, i) => (c.pick = i));

  const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
    .map((h) => (h.innerText || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    capurnionProbe: 1,
    host: location.host,
    url: location.href,
    title: document.title,
    headings,
    pageText: (document.body ? document.body.innerText : "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500),
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
})()
