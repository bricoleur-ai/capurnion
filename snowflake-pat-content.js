(() => {
  "use strict";
  const cfg = globalThis.CAPURNION_RULES?.snowflakePat;
  const api = globalThis.CAPURNION_PAT;
  if (!api?.validConfig(cfg) || window !== window.top || !api.isAccountPage(location.href, cfg)) return;
  if (globalThis.CAPURNION_PAT_CONTENT) return;
  globalThis.CAPURNION_PAT_CONTENT = true;
  let started = false, runId = null;
  function inspect() {
    const atSettings = api.isDestination(location.href, cfg);
    const section = document.querySelector('[data-testid="programmatic-access-tokens"]');
    const user = document.querySelector('[data-testid="user-context-menu-button"]');
    return {ready: atSettings && !!section && !!user, running: started,
      userMatches: user?.getAttribute("aria-label") === `Account Menu: ${cfg.expectedUser}`,
      step: !atSettings ? "Waiting for Snowflake authentication settings" : !user ? "Waiting for Snowflake sign-in" :
        !section ? "Waiting for the Programmatic access tokens section" : "Token list loaded"};
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "pat-inspect") { respond(inspect()); return; }
    if (message?.type !== "pat-run" || !api.isDestination(location.href, cfg)) return;
    if (started) { respond({started: message.runId === runId}); return; }
    started = true; runId = message.runId;
    respond({started: true});
    const send = (type, data = {}) => chrome.runtime.sendMessage({type, runId: message.runId, ...data});
    CAPURNION_PAT.run(document, cfg, {
      previousTokens: message.previousTokens || [],
      allow: async () => (await send("pat-guard")).allowed === true,
      progress: report => send("pat-progress", {report}),
      step: label => send("pat-step", {step: label}).catch(() => {}),
    }).then(report => send("pat-complete", {report})).catch(error => {
      console.warn(`[capurnion-pat] reporting failed: ${error.message}`);
    });
  });
  // The destination can initially render a login page at this same URL. Allow
  // the SSO engine to do its work before telling the worker to start renewal.
  let announced = false, sending = false;
  const observer = new MutationObserver(announce);
  function stop() { observer.disconnect(); clearTimeout(deadline); clearInterval(poll); }
  function announce() {
    if (announced || sending || !inspect().ready) return;
    sending = true;
    // Retry a lost acknowledgement even when the DOM no longer changes. Ordinary
    // tabs are explicitly declined and stop; only an owned job can receive a run.
    chrome.runtime.sendMessage({type: "pat-ready"}).then(reply => {
      if (reply?.allowed || (!reply?.retry && !reply?.error)) { announced = true; stop(); }
    }).catch(() => {}).finally(() => { sending = false; });
  }
  observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
  const poll = setInterval(announce, 5000);
  const deadline = setTimeout(stop, 300000);
  window.addEventListener("pagehide", stop, {once: true});
  announce();
})();
