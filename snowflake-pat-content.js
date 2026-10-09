(() => {
  "use strict";
  if (globalThis.CAPURNION_PAT_CONTENT) return;
  globalThis.CAPURNION_PAT_CONTENT = true;
  const cfg = globalThis.CAPURNION_RULES?.snowflakePat;
  if (!globalThis.CAPURNION_PAT?.validConfig(cfg) || window !== window.top || location.href !== cfg.url) return;
  let started = false, runId = null;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "pat-run") return;
    if (started) { respond({started: message.runId === runId}); return; }
    started = true; runId = message.runId;
    respond({started: true});
    const send = (type, data = {}) => chrome.runtime.sendMessage({type, runId: message.runId, ...data});
    CAPURNION_PAT.run(document, cfg, {
      previousTokens: message.previousTokens || [],
      allow: async () => (await send("pat-guard")).allowed === true,
      progress: report => send("pat-progress", {report}),
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
    if (announced || sending || location.href !== cfg.url ||
        !document.querySelector('[data-testid="programmatic-access-tokens"]') ||
        !document.querySelector('[data-testid="user-context-menu-button"]')) return;
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
