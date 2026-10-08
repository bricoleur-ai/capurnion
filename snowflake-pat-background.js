/* Chrome alarms survive service-worker suspension; jobs live in storage.session. */
"use strict";
importScripts("rules.generated.js", "snowflake-pat.js");
const PAT_CFG = globalThis.CAPURNION_RULES?.snowflakePat;
const CHECK_ALARM = "capurnion-pat-hourly";
const TIMEOUT_ALARM = "capurnion-pat-timeout";
const JOB_KEY = "patJob";
const STATUS_KEY = "patStatus";
const PAUSED_KEY = "patPaused";
const JOB_LIMIT_MS = 180000;
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error(`[capurnion-pat] ${error.message}`));
  return result;
}
const job = async () => (await chrome.storage.session.get(JOB_KEY))[JOB_KEY];
const paused = async () => (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
function trustedPage(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.url === PAT_CFG?.url;
}
function trustedPopup(sender) {
  return sender.id === chrome.runtime.id && ["pat-popup.html", "options.html"].some(page => sender.url === chrome.runtime.getURL(page));
}
async function badge(status) {
  const failure = status === "error" || status === "warning";
  await chrome.action.setBadgeText({text: failure ? "!" : status === "checking" ? "…" : status === "paused" ? "Ⅱ" : ""});
  await chrome.action.setBadgeBackgroundColor({color: failure ? "#b3261e" : "#2459a6"});
}
async function finish(current, report, close = true) {
  const latest = await job();
  if (!latest || latest.runId !== current.runId) return;
  await chrome.storage.session.remove(JOB_KEY);
  await chrome.alarms.clear(TIMEOUT_ALARM);
  const prior = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  const result = {startedAt: current.startedAt, checkedAt: Date.now(), ...prior, ...report};
  result.startedAt = current.startedAt;
  result.checkedAt = Date.now();
  await chrome.storage.local.set({[STATUS_KEY]: result});
  await badge(await paused() ? "paused" : result.status);
  if (close) {
    try {
      const tab = await chrome.tabs.get(current.tabId);
      if (!tab.active) await chrome.tabs.remove(current.tabId);
    } catch { /* The user may already have closed the tab. */ }
  }
}
async function ensureAlarm() {
  if (!CAPURNION_PAT.validConfig(PAT_CFG) || await paused()) {
    await chrome.alarms.clear(CHECK_ALARM);
    return;
  }
  const alarm = await chrome.alarms.get(CHECK_ALARM);
  if (!alarm || alarm.periodInMinutes !== 60)
    await chrome.alarms.create(CHECK_ALARM, {periodInMinutes: 60});
}
async function startCheck() {
  if (!CAPURNION_PAT.validConfig(PAT_CFG) || await paused()) return {started: false, reason: "Paused or disabled"};
  const existing = await job();
  if (existing && Date.now() - existing.startedAt < JOB_LIMIT_MS) return {started: false, reason: "A check is already running"};
  if (existing) await finish(existing, {status: "error", error: "Previous check timed out"});
  // Store the tab ID BEFORE navigating, so a fast content-script ready message is safe.
  const tab = await chrome.tabs.create({url: "about:blank", active: false});
  const current = {runId: crypto.randomUUID(), tabId: tab.id, startedAt: Date.now(), dispatched: false};
  await chrome.storage.session.set({[JOB_KEY]: current});
  await chrome.storage.local.set({[STATUS_KEY]: {status: "checking", startedAt: current.startedAt, tokens: [], renewed: [], warnings: []}});
  await badge("checking");
  await chrome.alarms.create(TIMEOUT_ALARM, {when: current.startedAt + JOB_LIMIT_MS});
  try { await chrome.tabs.update(tab.id, {url: PAT_CFG.url}); }
  catch (error) { await finish(current, {status: "error", error: error.message}); }
  return {started: true};
}
async function handleMessage(message, sender) {
  if (trustedPopup(sender)) {
    if (message.type === "pat-check-now") return startCheck();
    if (message.type === "pat-pause") {
      await chrome.storage.local.set({[PAUSED_KEY]: message.paused === true});
      await ensureAlarm();
      const current = await job();
      if (message.paused && current) await finish(current, {status: "error", error: "Check cancelled by Pause"});
      await badge(message.paused ? "paused" : "ok");
      return message.paused ? {paused: true} : startCheck();
    }
    if (message.type === "pat-status") {
      const stored = await chrome.storage.local.get([STATUS_KEY, PAUSED_KEY]);
      return {config: PAT_CFG, status: stored[STATUS_KEY], paused: stored[PAUSED_KEY] === true,
        nextCheck: (await chrome.alarms.get(CHECK_ALARM))?.scheduledTime};
    }
  }
  if (!trustedPage(sender)) return {allowed: false};
  const current = await job();
  if (!current || current.tabId !== sender.tab.id) return {allowed: false};
  const tab = await chrome.tabs.get(current.tabId);
  if (tab.active || await paused() || Date.now() - current.startedAt >= JOB_LIMIT_MS) return {allowed: false};
  if (message.type === "pat-ready") {
    if (!current.dispatched) {
      current.dispatched = true;
      await chrome.storage.session.set({[JOB_KEY]: current});
      await chrome.tabs.sendMessage(current.tabId, {type: "pat-run", runId: current.runId}, {frameId: 0});
    }
    return {allowed: true};
  }
  if (message.runId !== current.runId) return {allowed: false};
  if (message.type === "pat-guard") return {allowed: true};
  if (message.type === "pat-progress") {
    await chrome.storage.local.set({[STATUS_KEY]: {...message.report, status: "checking", startedAt: current.startedAt}});
    return {allowed: true};
  }
  if (message.type === "pat-complete") {
    await finish(current, message.report);
    return {allowed: true};
  }
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
    if (alarm.name === CHECK_ALARM) await startCheck();
    if (alarm.name === TIMEOUT_ALARM) {
      const current = await job();
      if (current) await finish(current, {status: "error", error: "Check timed out; page may require sign-in or its controls changed"});
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
  if (!changes.url || changes.url === PAT_CFG?.url || changes.url === "about:blank") return;
  serial(async () => {
    const current = await job();
    // Before dispatch, allow SSO/Okta redirects and the existing login rules to run.
    // Only an account change during an actual renewal must cancel the job.
    if (current?.tabId === tabId && current.dispatched)
      await finish(current, {status: "error", error: "Authentication settings changed during the renewal"});
  });
});
chrome.runtime.onInstalled.addListener(() => serial(async () => { await ensureAlarm(); await startCheck(); }));
chrome.runtime.onStartup.addListener(() => serial(async () => { await ensureAlarm(); await startCheck(); }));
serial(async () => {
  await ensureAlarm();
  const current = await job();
  if (current && Date.now() - current.startedAt >= JOB_LIMIT_MS)
    await finish(current, {status: "error", error: "Interrupted check expired"});
  else if (current && !(await chrome.alarms.get(TIMEOUT_ALARM)))
    await chrome.alarms.create(TIMEOUT_ALARM, {when: current.startedAt + JOB_LIMIT_MS});
  const status = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY];
  if (!current && (!status || status.status === "checking")) {
    await startCheck();
    return;
  }
  await badge(await paused() ? "paused" : status?.status || "ok");
});
