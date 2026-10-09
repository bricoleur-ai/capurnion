"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.JSDOM_MODULE || 'jsdom');
test('popup displays the actual waiting step and opens the current check tab',async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../pat-popup.html'),'utf8'),{url:'chrome-extension://test/pat-popup.html',runScripts:'outside-only'});
  const w=dom.window,messages=[];let update;
  const data={config:{url:'https://app.snowflake.com/testorg/testaccount/settings/authentication'},job:{tabId:17},paused:false,
    status:{status:'checking',phase:'snowflake',step:'Waiting for the Programmatic access tokens section',pageUrl:'https://app.snowflake.com/testorg/testaccount/settings/authentication',lastFailure:{error:'Previous page listener unavailable',at:Date.now()}},okta:{state:'active',checkedAt:Date.now()}};
  w.CAPURNION_RULES={vault:{enabled:true}};
  w.chrome={runtime:{async sendMessage(m){messages.push(m);return m.type==='pat-status' ? data : {opened:true};},openOptionsPage(){}},storage:{onChanged:{addListener(fn){update=fn;}}}};
  const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'../pat-popup.js'),'utf8'));await flush();
    assert.equal(w.document.getElementById('step').textContent,data.status.step);
    assert(w.document.getElementById('okta').textContent.includes('Signed in'));
    assert(w.document.getElementById('error').textContent.includes('Previous page listener unavailable'));
    const button=w.document.getElementById('open-check');assert.equal(button.hidden,false);button.click();await flush();
    assert(messages.some(m=>m.type==='pat-open-tab'));
    data.status.step='Confirming the new bypass window';update();await flush();
    assert.equal(w.document.getElementById('step').textContent,data.status.step);
    data.status.status='ok';data.status.step='Check complete';delete data.job;update();await flush();
    assert.equal(button.hidden,true);assert.equal(w.document.getElementById('error').textContent,'');
    assert.equal(w.document.getElementById('status').textContent,'Last check read no tokens; retry the check');
    data.status.tokens=[{name:'lapsed',temporaryAccess:'23 hours left on temporary access',expires:'Expires on Jan 5, 2027'}];
    data.status.renewed=['lapsed'];update();await flush();
    assert.equal(w.document.getElementById('status').textContent,'Last check: read 1 token; renewed 1');
  } finally {w.close();}
});
