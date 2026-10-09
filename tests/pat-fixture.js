"use strict";
// Minimal rendered fixture with the same stable selectors and ARIA roles as Snowsight.
module.exports = function fixture(options = {}) {
  const rows = options.rows || [
    {name: "due-one", timer: "1 hour left on temporary access"},
    {name: "due-two", timer: "59 minutes left on temporary access"},
    {name: "boundary", timer: "2 hours left on temporary access"},
    {name: "healthy", timer: "23 hours left on temporary access"},
    {name: "no-bypass", timer: ""},
  ];
  return `<!doctype html><html><body>
    <button data-testid="user-context-menu-button" aria-label="Account Menu: test-user">test-user</button>
    <div data-testid="programmatic-access-tokens">
      <h1>Programmatic access tokens</h1>
      <button role="radio" aria-checked="true">${options.expired ? "Expired" : "Active"}</button>
      <div id="rows"></div><div data-testid="pat-network-policy-disclaimer">Missing network policy</div>
    </div>
    <script>
      const options = ${JSON.stringify(options)};
      const tokens = ${JSON.stringify(rows)};
      window.grants = []; window.menuClicks = [];
      function render() {
        const root = document.getElementById('rows'); root.replaceChildren();
        for (const token of tokens) {
          const row = document.createElement('div'); row.setAttribute('role', 'row'); row.setAttribute('aria-label', token.name);
          const name = document.createElement('span'); name.dataset.testid='name'; name.textContent=token.name; row.append(name);
          if (token.timer) { const badge=document.createElement('button');badge.dataset.testid='bypass-timer';badge.textContent=token.timer;row.append(badge); }
          const expiry=document.createElement('p');expiry.dataset.testid='expires-at';expiry.textContent='Expires on Jan 5, 2027';row.append(expiry);
          const more=document.createElement(options.menuKind==='role-button'?'div':'button');
          if(options.menuKind==='role-button')more.setAttribute('role','button');
          if(options.menuKind==='labelledby'){
            const label=document.createElement('span');label.id='menu-label-'+tokens.indexOf(token);label.textContent='More options';row.append(label);
            more.setAttribute('aria-labelledby',label.id);
          }else if(options.menuKind!=='popup-trigger')more.setAttribute('aria-label','More options');
          if(options.menuKind!=='labelledby'){more.setAttribute('aria-haspopup','true');more.setAttribute('data-menu-trigger','true');}
          more.textContent='⋮';row.append(more);
          if(options.menuDelayMs){more.hidden=true;setTimeout(()=>{more.hidden=false;},options.menuDelayMs);}
          if(options.menuWithoutLayout)more.getClientRects=()=>[];
          if(options.disabledMenu)more.setAttribute('aria-disabled','true');
          if(options.permanentlyHiddenMenu)more.style.display='none';
          if(options.hiddenUntilScroll){more.hidden=true;row.scrollIntoView=()=>{more.hidden=false;};}
          if(options.missingMenu)more.remove();
          if(options.duplicateMenu){const duplicate=more.cloneNode(true);row.append(duplicate);duplicate.onclick=()=>window.menuClicks.push('wrong-menu');}
          more.onclick=()=>{window.menuClicks.push(token.name);openMenu(token);};root.append(row);
        }
      }
      function openMenu(token) {
        const menu=document.createElement('div');menu.setAttribute('role','menu');
        const action=document.createElement('button');action.setAttribute('role','menuitem');
        action.textContent=options.wrongMenu?'Revoke token':'Bypass requirement for network policy';menu.append(action);document.body.append(menu);
        action.onclick=()=>{menu.remove();openDialog(token);};
      }
      function openDialog(token) {
        const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.dataset.testid='bypass-network-policy-requirement-dialog';
        dialog.innerHTML='<h2 slot="title">Bypass network policy requirement</h2><label>Bypass window<input data-testid="bypass-amount" value="8"></label><button data-testid="bypass-unit-selector"></button><select style="display:none"><option value="1">Minutes</option><option value="60">Hours</option></select><button data-testid="grant-access">Grant access</button>';
        document.body.append(dialog);
        let amount='8';let unit=options.minutes?'Minutes':'Hours';
        const input=dialog.querySelector('input');const select=dialog.querySelector('select');const unitButton=dialog.querySelector('[data-testid="bypass-unit-selector"]');
        function syncUnit(){unitButton.textContent=unit;select.value=unit==='Hours'?'60':'1';} syncUnit();
        input.addEventListener('input',()=>{amount=input.value;if(options.rejectInput){amount='8';input.value='8';}});
        unitButton.onclick=()=>{
          const list=document.createElement('div');list.setAttribute('role','listbox');const hours=document.createElement('button');
          hours.setAttribute('role','option');hours.textContent='Hours';list.append(hours);document.body.append(list);
          hours.onclick=()=>{unit='Hours';syncUnit();list.remove();};
        };
        if(options.disableGrant)dialog.querySelector('[data-testid="grant-access"]').setAttribute('aria-disabled','true');
        if(options.changeToken)tokens[tokens.indexOf(token)]={name:token.name+'-changed',timer:token.timer};
        if(options.changeToken)render();
        dialog.querySelector('[data-testid="grant-access"]').onclick=()=>{
          window.grants.push({name:token.name,amount,unit});
          dialog.remove();
          if(!options.noConfirmation){token.timer='23 hours left on temporary access';render();}
        };
      }
      if(options.delayRowsMs)setTimeout(render,options.delayRowsMs);else render();
      if(options.loginFirst){
        const section=document.querySelector('[data-testid="programmatic-access-tokens"]');
        const user=document.querySelector('[data-testid="user-context-menu-button"]');section.remove();user.remove();
        const okta=document.createElement('button');okta.textContent='Sign in with Okta';document.body.append(okta);
        window.oktaClicks=0;okta.onclick=()=>{window.oktaClicks++;};
        window.finishLogin=()=>{okta.remove();document.body.append(user,section);};
      }
      if(options.otherDialog){const d=document.createElement('section');d.setAttribute('role','dialog');d.textContent='Other dialog';document.body.append(d);}
    </script></body></html>`;
};
