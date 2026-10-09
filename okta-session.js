/* Cookie-authenticated session observation; no API tokens, passwords, or IDs stored. */
(() => {
  "use strict";
  async function check(cfg, request = globalThis.fetch) {
    if (!cfg?.enabled) return {state: "disabled"};
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(cfg.host || ""))
      return {state: "unknown", checkedAt: Date.now(), error: "Invalid Okta host"};
    const checkedAt = Date.now();
    try {
      const response = await request(`https://${cfg.host}/api/v1/sessions/me`, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error",
        headers: {Accept: "application/json"}, signal: AbortSignal.timeout(10000),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 200 && data?.status === "ACTIVE") {
        const expiry = Date.parse(data.expiresAt);
        return {state: "active", checkedAt, ...(Number.isFinite(expiry) ? {expiresAt: expiry} : {})};
      }
      // A bare 404 can mean an unsupported endpoint, not an expired session.
      if ((response.status === 404 || response.status === 401) &&
          data?.errorCode === "E0000007" && /\bsession\b/i.test(data.errorSummary || ""))
        return {state: "signed-out", checkedAt};
      return {state: "unknown", checkedAt, error: `Okta session check returned HTTP ${response.status}`};
    } catch {
      return {state: "unknown", checkedAt, error: "Okta session check failed or timed out"};
    }
  }
  globalThis.CAPURNION_OKTA_SESSION = {check};
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.CAPURNION_OKTA_SESSION;
})();
