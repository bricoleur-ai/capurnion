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
  let now = seed.now || Date.now();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const sent = [], created = [], removed = [], notifications = [], injected = [];
  let oktaState = seed.oktaState || {state: "disabled"}, probes = 0, acceptRun = true;
  const area = data => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  });
  const chrome = {
    storage: {local: area(local), session: area(session)},
    runtime: {id:"test-extension", getURL:file=>`chrome-extension://test-extension/${file}`, onMessage:event(), onInstalled:event(), onStartup:event()},
    alarms: {onAlarm:event(), async get(name){return alarms[name];}, async create(name, options){alarms[name]={name,scheduledTime:options.when || now+(options.periodInMinutes || 1)*60000,...options};}, async clear(name){delete alarms[name];}},
    notifications: {onClicked:event(), async create(id,options) { notifications.push({id,...options}); }},
    action: {async setBadgeText(){}, async setBadgeBackgroundColor(){}},
    scripting: {async executeScript(options){injected.push(options);}},
    tabs: {onActivated:event(),onRemoved:event(),onUpdated:event(),
      async create(options){const tab={id:Object.keys(tabs).length+1,...options};tabs[tab.id]=tab;created.push({...tab});return tab;},
      async get(id){if(!tabs[id])throw Error("Tab closed");return tabs[id];},
      async update(id,options){Object.assign(tabs[id],options);chrome.tabs.onUpdated.fire(id,options);return tabs[id];},
      async remove(id){removed.push(id);delete tabs[id];chrome.tabs.onRemoved.fire(id);},
      async sendMessage(id,message){
        if(message.type==='pat-inspect')return seed.inspect ? seed.inspect(id,injected) : {ready:false,running:false,step:'Waiting for the Programmatic access tokens section'};
        sent.push({id,...message});return {started:acceptRun};
      },
    },
  };
  const context=vm.createContext({chrome,crypto:require("node:crypto").webcrypto,Date:Clock,URL,console,
    setTimeout:seed.fastTimeout ? (fn,ms)=>setTimeout(fn,Math.min(ms,20)) : setTimeout,clearTimeout,importScripts(){},
    CAPURNION_RULES:{snowflakePat:cfg,oktaLogin:seed.oktaConfig,rules:seed.rules || []},CAPURNION_PAT:api,
    CAPURNION_MATCH:require("../matcher.js"),CAPURNION_OKTA_SESSION:{async check(){probes++;return {...oktaState,checkedAt:now};}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../snowflake-pat-background.js"),"utf8"),context);
  const flush=async()=>{for(let i=0;i<4;i++)await vm.runInContext("queue",context);};
  const message=(body,sender)=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](body,sender,resolve));
  const popup={id:chrome.runtime.id,url:chrome.runtime.getURL("pat-popup.html")};
  const page=tabId=>({id:chrome.runtime.id,url:cfg.url,frameId:0,tab:{id:tabId}});
  return {chrome,local,session,alarms,tabs,sent,created,removed,notifications,injected,flush,message,popup,page,
    get now(){return now;},get probes(){return probes;},advance(ms){now+=ms;},setOkta(state){oktaState=state;},acceptRun(value){acceptRun=value;}};
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
  h.tabs[h.session.patJob.tabId].active=true;
  await h.message({type:'pat-pause',paused:true},h.popup);await h.flush();
  assert.equal(h.local.patPaused,true);assert.equal(h.alarms['capurnion-pat-hourly'],undefined);assert.equal(h.session.patJob,undefined);
  assert.equal((await h.message({type:'pat-check-now'},h.popup)).started,false);
});
test("worker restart retains an in-flight job and its timeout; timeout closes only its tab",async()=>{
  const first=harness();await first.flush();await first.message({type:'pat-check-now'},first.popup);const job=first.session.patJob;
  const restarted=harness(first);await restarted.flush();
  assert.equal(restarted.session.patJob.runId,job.runId);assert(restarted.alarms['capurnion-pat-timeout']);
  restarted.advance(300000);
  restarted.chrome.alarms.onAlarm.fire({name:'capurnion-pat-timeout'});await restarted.flush();
  assert.equal(restarted.session.patJob,undefined);assert.equal(restarted.local.patStatus.status,'error');assert.deepEqual(restarted.removed,[job.tabId]);
});
test("focusing the owned tab allows no-badge recovery to finish and closes that tab",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.tabs[job.tabId].active=true;h.chrome.tabs.onActivated.fire({tabId:job.tabId});await h.flush();
  assert.equal(h.session.patJob.runId,job.runId);assert.equal(h.removed.length,0);
  assert.equal((await h.message({type:'pat-ready'},h.page(job.tabId))).allowed,true);
  assert.equal((await h.message({type:'pat-guard',runId:job.runId},h.page(job.tabId))).allowed,true);
  await h.message({type:'pat-complete',runId:job.runId,report:{status:'ok',tokens:[{name:'lapsed',minutes:1380,temporaryAccess:'23 hours left on temporary access'}],renewed:['lapsed']}},h.page(job.tabId));await h.flush();
  assert.equal(h.local.patStatus.status,'ok');assert.deepEqual(h.local.patStatus.renewed,['lapsed']);
  assert.equal(h.session.patJob,undefined);assert.deepEqual(h.removed,[job.tabId]);
});

test("five-minute watchdog probes Okta but retains hourly PAT checks for healthy windows",async()=>{
  const h=harness({oktaState:{state:"active"}});await h.flush();const probes=h.probes;
  assert.equal(h.alarms['capurnion-pat-poll'].periodInMinutes,5);
  h.advance(300000);h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-poll'});await h.flush();
  assert.equal(h.probes,probes+1);assert.equal(h.created.length,0);assert.equal(h.local.patOktaSession.state,'active');
});
test("signed-out Okta opens one managed sign-in tab, then visits Snowflake only after session confirmation",async()=>{
  const h=harness({oktaState:{state:'signed-out'},oktaConfig:{enabled:true,host:'example.okta.com'}});await h.flush();
  const job=h.session.patJob;assert.equal(h.tabs[job.tabId].url,'https://example.okta.com/app/UserHome');
  assert.equal(job.phase,'okta');assert(h.alarms['capurnion-pat-auth-poll']);
  assert.equal((await h.message({type:'pat-ready'},h.page(job.tabId))).allowed,false);
  h.setOkta({state:'unknown'});h.advance(60000);h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-auth-poll'});await h.flush();
  assert.equal(h.session.patJob.phase,'okta');assert.equal(h.created.length,1);
  h.tabs[job.tabId].active=true;h.chrome.tabs.onActivated.fire({tabId:job.tabId});await h.flush();
  h.setOkta({state:'active'});h.chrome.tabs.onUpdated.fire(job.tabId,{status:'complete'});await h.flush();
  assert.equal(h.tabs[job.tabId].url,cfg.url);assert.equal(h.session.patJob.phase,'snowflake');
  assert.equal(h.alarms['capurnion-pat-auth-poll'].periodInMinutes,1);
  await h.message({type:'pat-ready'},h.page(job.tabId));
  await h.message({type:'pat-complete',runId:job.runId,report:{status:'ok',tokens:[{name:'recovered',expires:'later',minutes:1380,bypassExpiresAt:h.now+1380*60000}],renewed:['recovered']}},h.page(job.tabId));await h.flush();
  assert.deepEqual(h.removed,[job.tabId]);assert.equal(h.local.patTokenHistory[0].name,'recovered');assert.equal(h.local.patStatus.lastSuccessAt,h.now);
});
test("unknown Okta probe still allows normal Snowflake login and renewal",async()=>{
  const h=harness({oktaState:{state:'unknown',error:'endpoint unavailable'}});await h.flush();
  await h.message({type:'pat-check-now'},h.popup);
  assert.equal(h.session.patJob.phase,'snowflake');assert.equal(h.tabs[h.session.patJob.tabId].url,cfg.url);
});
test("failed checks retry at the next poll and alert without notification spam",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);let job=h.session.patJob;
  await h.message({type:'pat-ready'},h.page(job.tabId));
  await h.message({type:'pat-complete',runId:job.runId,report:{status:'error',error:'Login needed'}},h.page(job.tabId));await h.flush();
  assert.equal(h.notifications.length,1);h.advance(300000);h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-poll'});await h.flush();
  assert.equal(h.created.length,2);job=h.session.patJob;
  await h.message({type:'pat-ready'},h.page(job.tabId));
  await h.message({type:'pat-complete',runId:job.runId,report:{status:'error',error:'Login needed'}},h.page(job.tabId));await h.flush();
  assert.equal(h.notifications.length,1);
});
test("due countdown history starts a check between hourly checks",async()=>{
  const h=harness({local:{patStatus:{status:'ok',checkedAt:Date.now()},patTokenHistory:[{name:'due',bypassExpiresAt:Date.now()+121*60000}]}});await h.flush();
  assert.equal(h.created.length,0);h.advance(300000);h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-poll'});await h.flush();
  assert.equal(h.created.length,1);
});
test("lost run acknowledgement retains nonce authorization and retries delivery",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.acceptRun(false);const failed=await h.message({type:'pat-ready'},h.page(job.tabId));
  assert.equal(failed.retry,true);assert.equal(h.session.patJob.acknowledged,undefined);
  assert.equal((await h.message({type:'pat-guard',runId:job.runId},h.page(job.tabId))).allowed,true);
  h.acceptRun(true);assert.equal((await h.message({type:'pat-ready'},h.page(job.tabId))).allowed,true);
  assert.equal(h.session.patJob.acknowledged,true);
});
test("an early or stale timeout event cannot cancel a fresh job",async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-timeout'});await h.flush();
  assert.equal(h.session.patJob.runId,job.runId);assert.equal(h.alarms['capurnion-pat-timeout'].when,job.startedAt+300000);
});
test("late SSO recovery remains restricted to the owned tab and configured rule when focused",async()=>{
  const rule={id:'test-sso',enabled:true,kind:'idp-select',hosts:['app.snowflake.com'],require:{pageText:'sign in to testaccount'},click:{label:'sign in using okta sso'}};
  const h=harness({rules:[rule]});await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  const sender=h.page(job.tabId),message={type:'pat-sso-guard',ruleId:rule.id};
  assert.equal((await h.message(message,sender)).allowed,true);
  assert.equal((await h.message(message,h.page(999))).allowed,false);
  assert.equal((await h.message({...message,ruleId:'unconfigured'},sender)).allowed,false);
  h.tabs[job.tabId].active=true;assert.equal((await h.message(message,sender)).allowed,true);
  assert.equal((await h.message(message,{...sender,tab:{id:999}})).allowed,false);
});

test("actual no-badge grant workflow completes when the owned tab gains focus", async()=>{
  const {JSDOM}=require(process.env.JSDOM_MODULE || "jsdom");
  const fixture=require('./pat-fixture.js');
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  await h.message({type:'pat-ready'},h.page(job.tabId));
  const dom=new JSDOM(fixture({rows:[{name:'lapsed',timer:''}],minutes:true,delayRowsMs:120}),{url:cfg.url,runScripts:'dangerously',pretendToBeVisual:true});
  dom.window.Element.prototype.getClientRects=function(){return this.isConnected && !this.closest('[hidden]') && dom.window.getComputedStyle(this).display!=='none' ? [{}] : [];};
  let guards=0;
  try {
    const report=await api.run(dom.window.document,{...cfg,restoreMissingAccess:true},{timeoutMs:400,
      allow:async()=>{
        if(++guards===3){h.tabs[job.tabId].active=true;h.chrome.tabs.onActivated.fire({tabId:job.tabId});await h.flush();}
        return (await h.message({type:'pat-guard',runId:job.runId},h.page(job.tabId))).allowed;
      },progress:report=>h.message({type:'pat-progress',runId:job.runId,report},h.page(job.tabId))});
    assert.equal(report.status,'ok',report.error);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.grants)),[{name:'lapsed',amount:'24',unit:'Hours'}]);
    assert.deepEqual(report.renewed,['lapsed']);assert(h.tabs[job.tabId].active);
    await h.message({type:'pat-complete',runId:job.runId,report},h.page(job.tabId));await h.flush();
    assert.equal(h.local.patStatus.status,'ok');assert.equal(h.session.patJob,undefined);assert.deepEqual(h.removed,[job.tabId]);
  } finally {dom.window.close();}
});
test('worker attaches missing page automation and dispatches without a ready announcement',async()=>{
  const h=harness({inspect:async(id,injected)=>{if(!injected.length)throw Error('Receiving end does not exist');return {ready:true,running:true,step:'Token list loaded'};}});
  await h.flush();await h.message({type:'pat-check-now'},h.popup);await h.flush();
  const job=h.session.patJob;assert(job.acknowledged);assert.equal(h.injected.length,1);
  assert.equal(h.injected[0].target.tabId,job.tabId);assert.deepEqual(h.sent.map(m=>m.type),['pat-run']);
});
test('a nonresponding page listener times out instead of blocking the worker queue forever',async()=>{
  const h=harness({fastTimeout:true,inspect:()=>new Promise(()=>{})});await h.flush();
  await h.message({type:'pat-check-now'},h.popup);await h.flush();
  assert.equal(h.session.patJob,undefined);assert.equal(h.local.patStatus.status,'error');
  assert.match(h.local.patStatus.error,/Inspecting the check tab timed out/);
  assert.equal((await h.message({type:'pat-status'},h.popup)).status.status,'error');
});
test('heartbeat reports missing token section and the popup can focus only the owned tab',async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  assert.equal(h.local.patStatus.step,'Waiting for the Programmatic access tokens section');
  assert.equal(h.local.patStatus.pageUrl,cfg.url);assert.equal(h.alarms['capurnion-pat-auth-poll'].periodInMinutes,1);
  assert.equal((await h.message({type:'pat-open-tab'},h.page(job.tabId))).allowed,false);
  assert.equal((await h.message({type:'pat-open-tab'},h.popup)).opened,true);assert(h.tabs[job.tabId].active);
});
test('a signed-in homepage after SSO returns to the configured settings page',async()=>{
  const h=harness({inspect:async()=>({ready:false,running:false,userMatches:true,step:'Waiting for Snowflake authentication settings'})});
  await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.tabs[job.tabId].url='https://app.snowflake.com/testorg/testaccount/#/homepage';
  h.chrome.tabs.onUpdated.fire(job.tabId,{status:'complete'});await h.flush();
  assert.equal(h.tabs[job.tabId].url,cfg.url);assert.equal(h.session.patJob.returnAttempts,1);
});
test('page progress messages require the dispatched run nonce',async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  assert.equal((await h.message({type:'pat-step',runId:job.runId,step:'fake'},h.page(job.tabId))).allowed,false);
  await h.message({type:'pat-ready'},h.page(job.tabId));
  assert.equal((await h.message({type:'pat-step',runId:'wrong',step:'fake'},h.page(job.tabId))).allowed,false);
  await h.message({type:'pat-step',runId:job.runId,step:'Confirming new bypass window'},h.page(job.tabId));
  assert.equal(h.local.patStatus.step,'Confirming new bypass window');
});
test('worker exceptions clear the checking state and record an actionable failure',async()=>{
  const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
  h.chrome.tabs.get=async()=>{throw Error('Chrome tab unavailable');};
  await h.message({type:'pat-ready'},h.page(job.tabId));await h.flush();
  assert.equal(h.local.patStatus.status,'error');assert.equal(h.session.patJob,undefined);
  assert.equal(h.local.patStatus.lastFailure.error,'Chrome tab unavailable');
});
test('absent, blank, or malformed tab URLs wait for navigation and later resume inspection',async()=>{
  for (const value of [undefined,'','not a URL','about:blank']) {
    const h=harness();await h.flush();await h.message({type:'pat-check-now'},h.popup);const job=h.session.patJob;
    h.tabs[job.tabId].url=value;h.tabs[job.tabId].pendingUrl=cfg.url;
    h.chrome.tabs.onUpdated.fire(job.tabId,{status:'loading'});
    h.chrome.alarms.onAlarm.fire({name:'capurnion-pat-auth-poll'});await h.flush();
    assert.equal(h.local.patStatus.status,'checking');assert.equal(h.session.patJob.runId,job.runId);
    assert.equal(h.local.patStatus.step,'Waiting for the check tab to finish navigating');assert.equal(h.injected.length,0);
    if(!value)assert.equal((await h.message({type:'pat-ready'},h.page(job.tabId))).retry,true);
    h.tabs[job.tabId].url=cfg.url;h.chrome.tabs.onUpdated.fire(job.tabId,{status:'complete'});await h.flush();
    assert.equal(h.local.patStatus.step,'Waiting for the Programmatic access tokens section');
    assert.equal((await h.message({type:'pat-ready'},h.page(job.tabId))).allowed,true);
    assert.equal(h.session.patJob.acknowledged,true);
  }
});
