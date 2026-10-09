/* Durable alarms and jobs; no cached worker timer is required for recovery. */
"use strict";
importScripts("rules.generated.js", "matcher.js", "snowflake-pat.js", "okta-session.js");
const PAT_CFG = globalThis.CAPURNION_RULES?.snowflakePat;
const OKTA_CFG = globalThis.CAPURNION_RULES?.oktaLogin;
const CHECK_ALARM = "capurnion-pat-hourly", POLL_ALARM = "capurnion-pat-poll";
const TIMEOUT_ALARM = "capurnion-pat-timeout", AUTH_ALARM = "capurnion-pat-auth-poll";
const JOB_KEY = "patJob", STATUS_KEY = "patStatus", PAUSED_KEY = "patPaused";
const HISTORY_KEY = "patTokenHistory", OKTA_KEY = "patOktaSession";
const JOB_LIMIT_MS = 300000, POLL_MINUTES = 5;
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error(`[capurnion-pat] ${error.message}`));
  return result;
}
const job = async () => (await chrome.storage.session.get(JOB_KEY))[JOB_KEY];
const paused = async () => (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
function trustedPage(sender) {
  return sender?.id === chrome.runtime.id && sender.frameId === 0 && sender.url === PAT_CFG?.url;
}
function trustedPopup(sender) {
  return sender?.id === chrome.runtime.id && ["pat-popup.html", "options.html"].some(page => sender.url === chrome.runtime.getURL(page));
}
async function badge(status) {
  const failure = status === "error" || status === "warning";
  await chrome.action.setBadgeText({text: failure ? "!" : status === "checking" ? "…" : status === "paused" ? "Ⅱ" : ""});
  await chrome.action.setBadgeBackgroundColor({color: failure ? "#b3261e" : "#2459a6"});
}
async function alertFailure(report) {
  if (await paused() || !chrome.notifications || !["error", "warning"].includes(report.status)) return;
  const prior = (await chrome.storage.local.get("patAlertAt")).patAlertAt || 0;
  if (Date.now() - prior < 30 * 60000) return;
  try {
    await chrome.notifications.create("capurnion-pat-attention", {type: "basic",
      iconUrl: chrome.runtime.getURL("notification-icon.png"), title: "Capurnion: Snowflake access needs attention",
      message: (report.error || report.warnings?.[0] || "PAT renewal could not be confirmed. Open Capurnion to inspect sign-in and retry.").slice(0, 240)});
    await chrome.storage.local.set({patAlertAt: Date.now()});
  } catch { /* The badge and recorded error remain available if notifications are blocked. */ }
}
async function remember(report) {
  if (!Array.isArray(report.tokens) || !report.tokens.length) return;
  const old = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
  const tokens = report.tokens.map(token => {
    const previous = old.find(item => item.name === token.name && item.expires === token.expires);
    return {...token, bypassExpiresAt: token.bypassExpiresAt ?? previous?.bypassExpiresAt ?? null};
  });
  await chrome.storage.local.set({[HISTORY_KEY]: tokens});
}
async function pollOkta() {
  const state = await CAPURNION_OKTA_SESSION.check(OKTA_CFG);
  if (state.state !== "disabled") await chrome.storage.local.set({[OKTA_KEY]: state});
  return state;
}
async function finish(current, report, close = true) {
  const latest = await job();
  if (!latest || latest.runId !== current.runId) return;
  await chrome.storage.session.remove(JOB_KEY);
  await chrome.alarms.clear(TIMEOUT_ALARM); await chrome.alarms.clear(AUTH_ALARM);
  await remember(report);
  const prior = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  const result = {...prior, ...report, phase: "complete", startedAt: current.startedAt, checkedAt: Date.now()};
  if (report.status === "ok") result.lastSuccessAt = result.checkedAt;
  await chrome.storage.local.set({[STATUS_KEY]: result});
  await badge(await paused() ? "paused" : result.status);
  await alertFailure(result);
  if (close) {
    try {
      const tab = await chrome.tabs.get(current.tabId);
      if (!tab.active) await chrome.tabs.remove(current.tabId);
    } catch { /* The user may already have closed the tab. */ }
  }
}
async function ensureAlarm() {
  if (!CAPURNION_PAT.validConfig(PAT_CFG) || await paused()) {
    for (const name of [CHECK_ALARM, POLL_ALARM, AUTH_ALARM]) await chrome.alarms.clear(name);
    return;
  }
  for (const [name, period] of [[CHECK_ALARM, 60], [POLL_ALARM, POLL_MINUTES]]) {
    const alarm = await chrome.alarms.get(name);
    if (!alarm || alarm.periodInMinutes !== period) await chrome.alarms.create(name, {periodInMinutes: period});
  }
}
async function startCheck(knownSession) {
  if (!CAPURNION_PAT.validConfig(PAT_CFG) || await paused()) return {started: false, reason: "Paused or disabled"};
  const existing = await job();
  if (existing && Date.now() - existing.startedAt < JOB_LIMIT_MS) return {started: false, reason: "A check is already running"};
  if (existing) await finish(existing, {status: "error", error: "Previous check timed out"});
  const session = knownSession || await pollOkta();
  // Persist ownership before navigation so even a very fast ready message is safe.
  const tab = await chrome.tabs.create({url: "about:blank", active: false});
  const current = {runId: crypto.randomUUID(), tabId: tab.id, startedAt: Date.now(), dispatched: false,
    phase: session.state === "signed-out" ? "okta" : "snowflake"};
  await chrome.storage.session.set({[JOB_KEY]: current});
  const prior = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  await chrome.storage.local.set({[STATUS_KEY]: {...prior, status: "checking", phase: current.phase,
    startedAt: current.startedAt, error: null, renewed: [], warnings: []}});
  await badge("checking");
  await chrome.alarms.create(TIMEOUT_ALARM, {when: current.startedAt + JOB_LIMIT_MS});
  if (current.phase === "okta") await chrome.alarms.create(AUTH_ALARM, {periodInMinutes: 1});
  try {
    await chrome.tabs.update(tab.id, {url: current.phase === "okta" ? `https://${OKTA_CFG.host}/app/UserHome` : PAT_CFG.url});
  } catch (error) { await finish(current, {status: "error", error: error.message}); }
  return {started: true};
}
async function advanceSignIn(current, session) {
  if (current.phase !== "okta" || session.state !== "active") return;
  const tab = await chrome.tabs.get(current.tabId);
  if (tab.active || await paused()) return;
  current.phase = "snowflake";
  await chrome.storage.session.set({[JOB_KEY]: current});
  await chrome.alarms.clear(AUTH_ALARM);
  const prior = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  await chrome.storage.local.set({[STATUS_KEY]: {...prior, phase: "snowflake"}});
  await chrome.tabs.update(current.tabId, {url: PAT_CFG.url});
}
async function monitor(force = false) {
  if (!CAPURNION_PAT.validConfig(PAT_CFG) || await paused()) return;
  await ensureAlarm();
  let current = await job();
  if (current && Date.now() - current.startedAt >= JOB_LIMIT_MS) {
    await finish(current, {status: "error", error: current.phase === "okta" ? "Okta sign-in timed out; inspect Settings & vault and sign-in" : "PAT check timed out; sign-in or page controls may need attention"});
    current = null;
  }
  const session = await pollOkta();
  if (current) { await advanceSignIn(current, session); return; }
  const stored = await chrome.storage.local.get([STATUS_KEY, HISTORY_KEY]);
  const status = stored[STATUS_KEY];
  // Countdown history catches a due window between hourly checks and after sleep.
  const approaching = (stored[HISTORY_KEY] || []).some(token => Number.isFinite(token.bypassExpiresAt) &&
    token.bypassExpiresAt <= Date.now() + PAT_CFG.renewBelowMinutes * 60000);
  if (force || !status || ["error", "warning", "checking"].includes(status.status) || approaching ||
      session.state === "signed-out" || Date.now() - (status.checkedAt || 0) >= 60 * 60000)
    await startCheck(session);
}
async function handleMessage(message, sender) {
  if (trustedPopup(sender)) {
    if (message.type === "pat-check-now") return startCheck();
    if (message.type === "pat-pause") {
      await chrome.storage.local.set({[PAUSED_KEY]: message.paused === true}); await ensureAlarm();
      const current = await job();
      if (message.paused && current) await finish(current, {status: "error", error: "Check cancelled by Pause"});
      await badge(message.paused ? "paused" : "ok");
      return message.paused ? {paused: true} : startCheck();
    }
    if (message.type === "pat-status") {
      const stored = await chrome.storage.local.get([STATUS_KEY, PAUSED_KEY, OKTA_KEY]);
      return {config: PAT_CFG, status: stored[STATUS_KEY], paused: stored[PAUSED_KEY] === true, okta: stored[OKTA_KEY],
        nextCheck: (await chrome.alarms.get(CHECK_ALARM))?.scheduledTime,
        nextPoll: (await chrome.alarms.get(POLL_ALARM))?.scheduledTime};
    }
  }
  if (message.type === "pat-sso-guard") {
    const current = await job();
    if (!current || sender?.id !== chrome.runtime.id || sender.frameId !== 0 ||
        sender.tab?.id !== current.tabId || current.dispatched || current.phase === "okta" ||
        await paused() || Date.now() - current.startedAt >= JOB_LIMIT_MS) return {allowed: false};
    const tab = await chrome.tabs.get(current.tabId);
    const host = new URL(sender.url).hostname;
    const rule = CAPURNION_RULES.rules?.find(item => item.id === message.ruleId);
    return {allowed: !tab.active && tab.url === sender.url &&
      (host === "app.snowflake.com" || host.endsWith(".snowflakecomputing.com")) &&
      rule?.enabled === true && rule.kind === "idp-select" && CAPURNION_MATCH.hostListed(rule, host)};
  }
  if (!trustedPage(sender)) return {allowed: false};
  const current = await job();
  if (!current || current.tabId !== sender.tab?.id || current.phase === "okta") return {allowed: false};
  const tab = await chrome.tabs.get(current.tabId);
  if (tab.active || tab.url !== PAT_CFG.url || await paused() || Date.now() - current.startedAt >= JOB_LIMIT_MS) return {allowed: false};
  if (message.type === "pat-ready") {
    if (!current.acknowledged) {
      const previousTokens = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
      // Persist nonce authorization before delivery. If the acknowledgement is
      // lost, a delivered run can still finish and repeated delivery is idempotent.
      current.dispatched = true; await chrome.storage.session.set({[JOB_KEY]: current});
      const accepted = await chrome.tabs.sendMessage(current.tabId, {type: "pat-run", runId: current.runId, previousTokens}, {frameId: 0});
      if (accepted?.started !== true) return {allowed: false, retry: true};
      current.acknowledged = true; await chrome.storage.session.set({[JOB_KEY]: current});
    }
    return {allowed: true};
  }
  if (message.runId !== current.runId || !current.dispatched) return {allowed: false};
  if (message.type === "pat-guard") return {allowed: true};
  if (message.type === "pat-progress") {
    await remember(message.report);
    const prior = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    await chrome.storage.local.set({[STATUS_KEY]: {...prior, ...message.report, status: "checking", phase: current.phase, startedAt: current.startedAt}});
    return {allowed: true};
  }
  if (message.type === "pat-complete") { await finish(current, message.report); return {allowed: true}; }
  return {allowed: false};
}
// Register listeners synchronously so Chrome can wake a suspended worker.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith("pat-")) return;
  serial(() => handleMessage(message, sender)).then(respond, error => respond({allowed: false, error: error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  serial(async () => {
    if (alarm.name === CHECK_ALARM) await monitor(true);
    if (alarm.name === POLL_ALARM || alarm.name === AUTH_ALARM) await monitor();
    if (alarm.name === TIMEOUT_ALARM) {
      const current = await job();
      if (current && Date.now() - current.startedAt >= JOB_LIMIT_MS)
        await finish(current, {status: "error", error: current.phase === "okta" ? "Okta sign-in timed out; inspect the vault credentials and sign-in" : "Check timed out; page may require sign-in or its controls changed"});
      else if (current) await chrome.alarms.create(TIMEOUT_ALARM, {when: current.startedAt + JOB_LIMIT_MS});
    }
  });
});
chrome.tabs.onActivated.addListener(info => {
  serial(async () => {
    const current = await job();
    if (current?.tabId === info.tabId) await finish(current, {status: "error", error: "Check stopped because its background tab was activated"}, false);
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const current = await job();
    if (current?.tabId === tabId) await finish(current, {status: "error", error: "Check tab was closed"}, false);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  serial(async () => {
    const current = await job();
    if (current?.tabId !== tabId) return;
    if (changes.url && changes.url !== PAT_CFG?.url && changes.url !== "about:blank" && current.dispatched)
      await finish(current, {status: "error", error: "Authentication settings changed during the renewal"});
    else if (current.phase === "okta" && changes.status === "complete") await advanceSignIn(current, await pollOkta());
  });
});
chrome.notifications?.onClicked.addListener(id => {
  if (id === "capurnion-pat-attention") chrome.tabs.create({url: PAT_CFG.url, active: true});
});
chrome.runtime.onInstalled.addListener(() => serial(async () => { await ensureAlarm(); await monitor(true); }));
chrome.runtime.onStartup.addListener(() => serial(async () => { await ensureAlarm(); await monitor(true); }));
serial(async () => {
  await ensureAlarm();
  const current = await job();
  if (current) {
    if (!(await chrome.alarms.get(TIMEOUT_ALARM))) await chrome.alarms.create(TIMEOUT_ALARM, {when: current.startedAt + JOB_LIMIT_MS});
    if (current.phase === "okta" && !(await chrome.alarms.get(AUTH_ALARM))) await chrome.alarms.create(AUTH_ALARM, {periodInMinutes: 1});
  }
  await monitor();
  const status = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY];
  await badge(await paused() ? "paused" : status?.status || "ok");
});
