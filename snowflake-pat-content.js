(() => {
  "use strict";
  if (globalThis.CAPURNION_PAT_CONTENT) return;
  globalThis.CAPURNION_PAT_CONTENT = true;
  const cfg = globalThis.CAPURNION_RULES?.snowflakePat;
  if (!globalThis.CAPURNION_PAT?.validConfig(cfg) || window !== window.top || location.href !== cfg.url) return;
  let started = false;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "pat-run" || started) return;
    started = true;
    respond({started: true});
    const send = (type, data = {}) => chrome.runtime.sendMessage({type, runId: message.runId, ...data});
    CAPURNION_PAT.run(document, cfg, {
      allow: async () => (await send("pat-guard")).allowed === true,
      progress: report => send("pat-progress", {report}),
    }).then(report => send("pat-complete", {report})).catch(error => {
      console.warn(`[capurnion-pat] reporting failed: ${error.message}`);
    });
  });
  // The destination can initially render a login page at this same URL. Allow
  // the SSO engine to do its work before telling the worker to start renewal.
  let announced = false;
  const observer = new MutationObserver(announce);
  function announce() {
    if (announced || location.href !== cfg.url ||
        !document.querySelector('[data-testid="programmatic-access-tokens"]') ||
        !document.querySelector('[data-testid="user-context-menu-button"]')) return;
    announced = true;
    observer.disconnect();
    clearTimeout(deadline);
    // Ordinary user tabs announce themselves but never receive a run command.
    chrome.runtime.sendMessage({type: "pat-ready"}).catch(() => {});
  }
  observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
  const deadline = setTimeout(() => observer.disconnect(), 180000);
  announce();
})();
