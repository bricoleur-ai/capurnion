"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {check} = require("../okta-session.js");
const cfg = {enabled:true,host:"example.okta.com"};
const response = (status,data) => async () => ({status,json:async()=>data});
test("observes active cookie session with no credentials or session IDs retained",async()=>{
  const state=await check(cfg,async(url,options)=>{
    assert.equal(url,'https://example.okta.com/api/v1/sessions/me');
    assert.equal(options.credentials,'include');assert.equal(options.cache,'no-store');
    assert.equal(options.redirect,'error');assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization,undefined);
    return {status:200,json:async()=>({status:'ACTIVE',id:'private-session-id',userId:'private-user-id',expiresAt:'2027-01-01T00:00:00Z'})};
  });
  assert.equal(state.state,'active');assert.equal(state.expiresAt,Date.parse('2027-01-01T00:00:00Z'));
  assert(!JSON.stringify(state).includes('private'));
});
test("only a structured missing-session response counts as signed out",async()=>{
  const state=await check(cfg,response(404,{errorCode:'E0000007',errorSummary:'Not found: Session'}));
  assert.equal(state.state,'signed-out');
  for (const [status,data] of [[404,{}],[401,{errorCode:'E0000004'}],[429,{}],[200,{status:'INACTIVE'}],[403,{errorCode:'E0000007',errorSummary:'Not found: Resource'}]])
    assert.equal((await check(cfg,response(status,data))).state,'unknown');
});
test("unsupported HTML response and failed fetch are unknown, not logged out",async()=>{
  assert.equal((await check(cfg,async()=>({status:404,json:async()=>{throw Error('HTML');}}))).state,'unknown');
  const state=await check(cfg,async()=>{throw Error('private network detail');});
  assert.equal(state.state,'unknown');assert(!state.error.includes('private'));
});
test("disabled and malformed hosts never send requests",async()=>{
  const request=()=>{throw Error('should not fetch');};
  assert.equal((await check({enabled:false},request)).state,'disabled');
  assert.equal((await check({enabled:true,host:'example.okta.com/unwanted'},request)).state,'unknown');
});
