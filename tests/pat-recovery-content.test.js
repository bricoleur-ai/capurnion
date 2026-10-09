"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.JSDOM_MODULE || 'jsdom');
function harness(url,html) {
  const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window;
  let now=Date.now(),id=0;const intervals=new Map(),timeouts=new Map();
  w.Date.now=()=>now;
  w.setInterval=(fn)=>{intervals.set(++id,fn);return id;};w.clearInterval=id=>intervals.delete(id);
  w.setTimeout=(fn)=>{timeouts.set(++id,fn);return id;};w.clearTimeout=id=>timeouts.delete(id);
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.Element.prototype.getClientRects=function(){return this.isConnected ? [{}] : [];};
  const load=file=>w.eval(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {w,load,intervals,async poll(ms=5000){now+=ms;for(const fn of [...intervals.values()])fn();await flush();},flush,close(){w.close();}};
}
const cfg={enabled:true,confirmGrantsAccess:true,url:'https://app.snowflake.com/testorg/testaccount/settings/authentication',expectedUser:'test-user',intervalMinutes:60,renewBelowMinutes:120,grantHours:24};
test('PAT readiness retries without a DOM mutation and duplicate runs execute once',async()=>{
  const h=harness(cfg.url,'<div data-testid="programmatic-access-tokens"></div><button data-testid="user-context-menu-button"></button>');
  let listener,calls=0,runs=0;
  h.w.CAPURNION_RULES={snowflakePat:cfg};h.w.CAPURNION_PAT={validConfig:()=>true,run:async()=>{runs++;return {status:'ok'};}};
  h.w.chrome={runtime:{id:'test',onMessage:{addListener(fn){listener=fn;}},async sendMessage(m){if(m.type==='pat-ready'){calls++;if(calls===1)throw Error('Worker not ready');return {allowed:true};}return {allowed:true};}}};
  h.load('snowflake-pat-content.js');await h.flush();assert.equal(calls,1);
  await h.poll();assert.equal(calls,2);assert.equal(h.intervals.size,0);
  const answers=[];for(const runId of ['same','same','wrong'])listener({type:'pat-run',runId},{id:'test'},x=>answers.push(x.started));
  await h.flush();assert.equal(runs,1);assert.deepEqual(answers,[true,true,false]);h.close();
});
test('late SSO follows configured guards and background authorization, and clicks once',async()=>{
  const h=harness(cfg.url,'<h1>Sign in to testaccount</h1><button>Sign in using Okta SSO</button>');
  let clicks=0,allowed=false;h.w.document.querySelector('button').onclick=()=>clicks++;
  h.w.CAPURNION_RULES={snowflakePat:cfg,rules:[{id:'sso',enabled:true,kind:'idp-select',hosts:['app.snowflake.com'],require:{pageText:'sign in to testaccount'},click:{label:'sign in using okta sso'}}]};
  h.w.chrome={runtime:{async sendMessage(m){assert.equal(m.type,'pat-sso-guard');return {allowed};}}};
  h.load('matcher.js');h.load('snowflake-sso-watch.js');await h.poll(20000);assert.equal(clicks,0);
  allowed=true;h.w.document.querySelector('h1').textContent='Wrong account';await h.poll();assert.equal(clicks,0);
  h.w.document.querySelector('h1').textContent='Sign in to testaccount';await h.poll();assert.equal(clicks,1);
  await h.poll();assert.equal(clicks,1);h.close();
});
test('Okta credentials retry when vault availability changes without DOM activity, then submit once',async()=>{
  const h=harness('https://example.okta.com/login','<form><input name="identifier"><input type="password" name="credentials.passcode"><button type="button">Sign in</button></form>');
  let requests=0,clicks=0;h.w.document.querySelector('button').onclick=()=>clicks++;
  h.w.CAPURNION_RULES={oktaLogin:{enabled:true,confirmAutomatesMfa:true,host:'example.okta.com'}};
  h.w.chrome={runtime:{async sendMessage(){requests++;return requests===1 ? {ok:false} : {ok:true,username:'test-user',password:'test-password'};}}};
  h.load('okta-login-flow.js');h.load('okta-login-content.js');await h.flush();assert.equal(clicks,0);
  await h.poll(31000);assert.equal(clicks,1);assert.equal(h.w.document.querySelector('input[type="password"]').value,'test-password');
  await h.poll();assert.equal(clicks,1);h.w.dispatchEvent(new h.w.Event('pagehide'));assert.equal(h.intervals.size,0);h.close();
});
