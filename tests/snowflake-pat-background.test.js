"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../snowflake-pat.js");
const cfg = {enabled:true,confirmGrantsAccess:true,url:"https://app.snowflake.com/testorg/testaccount/settings/authentication",expectedUser:"test-user",intervalMinutes:60,renewBelowMinutes:120,grantHours:24};
function event() { return {listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(...args) { this.listeners.forEach(fn => fn(...args)); }}; }
function harness(seed = {}) {
  const local = seed.local || {patStatus: {status: "ok", checkedAt: Date.now()}};
  const session = seed.session || {};
  const alarms = seed.alarms || {};
  const tabs = seed.tabs || {};
  const sent = [], created = [], removed = [];
  const area = data => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  });
  const chrome = {
    storage: {local: area(local), session: area(session)},
    runtime: {id:"test-extension", getURL:file=>`chrome-extension://test-extension/${file}`, onMessage:event(), onInstalled:event(), onStartup:event()},
    alarms: {onAlarm:event(), async get(name){return alarms[name];}, async create(name, options){alarms[name]={name,scheduledTime:options.when || Date.now()+(options.periodInMinutes || 1)*60000,...options};}, async clear(name){delete alarms[name];}},
    action: {async setBadgeText(){}, async setBadgeBackgroundColor(){}},
    tabs: {onActivated:event(),onRemoved:event(),onUpdated:event(),
      async create(options){const tab={id:Object.keys(tabs).length+1,...options};tabs[tab.id]=tab;created.push({...tab});return tab;},
      async get(id){if(!tabs[id])throw Error("Tab closed");return tabs[id];},
      async update(id,options){Object.assign(tabs[id],options);chrome.tabs.onUpdated.fire(id,options);return tabs[id];},
      async remove(id){removed.push(id);delete tabs[id];chrome.tabs.onRemoved.fire(id);},
      async sendMessage(id,message){sent.push({id,...message});},
    },
  };
  const context=vm.createContext({chrome,crypto:require("node:crypto").webcrypto,Date,console,importScripts(){},CAPURNION_RULES:{snowflakePat:cfg},CAPURNION_PAT:api});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../snowflake-pat-background.js"),"utf8"),context);
  const flush=async()=>{for(let i=0;i<4;i++)await vm.runInContext("queue",context);};
  const message=(body,sender)=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](body,sender,resolve));
  const popup={id:chrome.runtime.id,url:chrome.runtime.getURL("pat-popup.html")};
  const page=tabId=>({id:chrome.runtime.id,url:cfg.url,frameId:0,tab:{id:tabId}});
  return {chrome,local,session,alarms,tabs,sent,created,removed,flush,message,popup,page};
}
test("creates a separate inactive tab before navigation and schedules hourly checks",async()=>{
  const h=harness();await h.flush();
  assert.equal(h.alarms['capurnion-pat-hourly'].periodInMinutes,60);
  await h.message({type:'pat-check-now'},h.popup);await h.flush();
  assert.equal(h.created.length,1);assert.equal(h.created[0].active,false);assert.equal(h.created[0].url,'about:blank');
  const job=h.session.patJob;assert.equal(h.tabs[job.tabId].url,cfg.url);
  await h.message({type:'pat-ready'},h.page(job.tabId));
  assert.equal(h.sent[0].type,'pat-run');assert.equal(h.sent[0].runId,job.runId);
  await h.message({type:'pat-complete',runId:job.runId,report:{status:'ok',tokens:[],renewed:['example']}},h.page(job.tabId));await h.flush();
  assert.deepEqual(h.removed,[job.tabId]);assert.equal(h.session.patJob,undefined);assert.equal(h.local.patStatus.status,'ok');
});
test("first installation starts a check as soon as the worker loads",async()=>{
  const h=harness({local:{}});await h.flush();
  assert.equal(h.created.length,1);assert(h.session.patJob);
});
test("allows Okta/login navigation before dispatch; starts after returning to settings",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);
  const job=h.session.patJob;
  h.chrome.tabs.onUpdated.fire(job.tabId,{url:'https://example.okta.com/login'});await h.flush();
  assert(h.session.patJob);assert.equal(h.removed.length,0);
  await h.message({type:'pat-ready'},h.page(job.tabId));assert.equal(h.sent.length,1);
  h.chrome.tabs.onUpdated.fire(job.tabId,{url:'https://app.snowflake.com/another/account/settings/authentication'});await h.flush();
  assert.equal(h.local.patStatus.status,'error');assert.deepEqual(h.removed,[job.tabId]);
});
test("ordinary tabs, other frames, and wrong nonces cannot start or authorize a renewal",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  assert.equal((await h.message({type:'pat-ready'},h.page(999))).allowed,false);
  assert.equal((await h.message({type:'pat-ready'},{...h.page(job.tabId),frameId:1})).allowed,false);
  assert.equal((await h.message({type:'pat-guard',runId:'wrong'},h.page(job.tabId))).allowed,false);
  assert.equal(h.sent.length,0);
});
test("checks cannot overlap; paused capability clears schedule and stops current job",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);
  const second=await h.message({type:'pat-check-now'},h.popup);assert.equal(second.started,false);assert.equal(h.created.length,1);
  await h.message({type:'pat-pause',paused:true},h.popup);await h.flush();
  assert.equal(h.local.patPaused,true);assert.equal(h.alarms['capurnion-pat-hourly'],undefined);assert.equal(h.session.patJob,undefined);
  assert.equal((await h.message({type:'pat-check-now'},h.popup)).started,false);
});
test("worker restart retains an in-flight job and its timeout; timeout closes only its tab",async()=>{
  const first=harness();await first.flush();await first.message({type:'pat-check-now'},first.popup);const job=first.session.patJob;
  const restarted=harness(first);await restarted.flush();
  assert.equal(restarted.session.patJob.runId,job.runId);assert(restarted.alarms['capurnion-pat-timeout']);
  restarted.chrome.alarms.onAlarm.fire({name:'capurnion-pat-timeout'});await restarted.flush();
  assert.equal(restarted.session.patJob,undefined);assert.equal(restarted.local.patStatus.status,'error');assert.deepEqual(restarted.removed,[job.tabId]);
});
test("taking over the background tab cancels automation and keeps the user's tab open",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.tabs[job.tabId].active=true;h.chrome.tabs.onActivated.fire({tabId:job.tabId});await h.flush();
  assert.equal(h.session.patJob,undefined);assert.equal(h.removed.length,0);assert(h.tabs[job.tabId]);
});
