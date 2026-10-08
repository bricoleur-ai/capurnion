"use strict";
const byId = id => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({type, ...data});
byId("options").hidden = !globalThis.CAPURNION_RULES?.vault?.enabled;
byId("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
let isPaused = false;
function date(value) { return value ? new Date(value).toLocaleString() : "Not yet"; }
async function refresh() {
  const data = await send("pat-status");
  if (!data?.config) throw new Error(data?.error || "Renewal capability is unavailable");
  const status = data.status || {};
  isPaused = data.paused;
  const labels = {checking: "Checking…", ok: "Last check succeeded", error: "Last check failed", warning: "Last check has skipped tokens"};
  byId("status").textContent = isPaused ? "Paused" : labels[status.status] || "Waiting for the first check";
  byId("times").textContent = `Last completed check: ${date(status.checkedAt)}\nNext check: ${isPaused ? "Paused" : date(data.nextCheck)}`;
  byId("times").style.whiteSpace = "pre-line";
  byId("error").textContent = [status.error, ...(status.warnings || [])].filter(Boolean).join("\n");
  byId("pause").textContent = isPaused ? "Resume" : "Pause";
  byId("check").disabled = isPaused || status.status === "checking";
  byId("settings").href = data.config.url;
  const tbody = byId("tokens").querySelector("tbody");
  tbody.replaceChildren();
  for (const token of status.tokens || []) {
    const row = document.createElement("tr");
    for (const value of [token.name, token.temporaryAccess || "No temporary-access timer", token.expires]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    tbody.append(row);
  }
  byId("tokens").hidden = !tbody.children.length;
}
async function act(type, data) {
  try {
    const result = await send(type, data);
    if (result?.error) throw new Error(result.error);
    await refresh();
  } catch (error) { byId("error").textContent = error.message; }
}
byId("check").addEventListener("click", () => act("pat-check-now"));
byId("pause").addEventListener("click", () => act("pat-pause", {paused: !isPaused}));
chrome.storage.onChanged.addListener(() => refresh().catch(error => { byId("error").textContent = error.message; }));
refresh().catch(error => { byId("error").textContent = error.message; });
