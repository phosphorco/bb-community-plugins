const { createRequire } = require('node:module');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = createRequire('/home/ubuntu/bb/community-plugins/plugins/analytics/package.json')('playwright');
const out = '/home/ubuntu/bb/community-plugins/plans/bb-plugin-guide-for-nerds/evidence/review';
const root = '/home/ubuntu/bb/community-plugins/plugins/plugin-guide-for-nerds';
const url = new URL('/projects/proj_t8x9yhwnvc/threads/thr_pk5kwrdyjm', process.env.BB_SERVER_URL).href;
const cases = [];
const frame = p => p.getByRole('dialog', { name: 'BB Plugin Guide for Nerds', exact: true });
const toggle = p => p.getByRole('button', { name: 'Toggle BB Plugin Guide for Nerds', exact: true });
async function start(context) { const p = await context.newPage(); await p.goto(url); await toggle(p).waitFor(); return p; }
async function ready(p) { await frame(p).locator('[data-guide-content]').waitFor(); }
async function safeFocus(p) { return p.evaluate(() => { const e=document.activeElement; return { tag:e.tagName, label:e.getAttribute('aria-label'), text:e.textContent?.slice(0,80), inside:!!e.closest('[data-guide-frame][role="dialog"][aria-modal="false"]'), inert:!!e.closest('[hidden],[inert]') }; }); }
(async () => { let browser;
try {
 browser = await chromium.launch({ headless:true, executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args:['--no-sandbox'] });
 const desktop = await browser.newContext({ viewport:{ width:1440,height:1000 } });
 const p = await start(desktop); await toggle(p).click(); await ready(p);
 let active=frame(p).locator('[data-map-section]:not([inert])');
 const hotspot=active.locator('a[href="#surface-sidebar-navigation"]').first();
 await hotspot.focus(); await p.keyboard.press('Enter');
 const card=frame(p).locator('[data-guide-card]'); await card.waitFor();
 await card.getByRole('button',{name:'Close',exact:true}).focus(); await p.keyboard.press('Escape');
 assert.equal(await card.count(),0); assert.equal(await hotspot.evaluate(e=>e===document.activeElement),true);
 cases.push({name:'card Escape restores opener',focus:await safeFocus(p)});
 await p.keyboard.press('ArrowRight');
 assert.equal(await frame(p).locator('[data-guide-page-list-scroll] [aria-current="true"]').evaluate(e=>e===document.activeElement),true);
 cases.push({name:'arrow from fixture transfers focus',focus:await safeFocus(p)});
 await frame(p).locator('[data-guide-page-list-scroll]').getByRole('button',{name:'Command palette',exact:true}).click();
 active=frame(p).locator('[data-map-section]:not([inert])');
 const search=active.getByRole('textbox',{name:'Search commands',exact:true}); await search.focus(); await p.keyboard.press('Escape');
 assert.equal(await active.locator('[data-guide-fixture="command-palette-shortcut"]').evaluate(e=>e===document.activeElement),true);
 cases.push({name:'palette Escape restores shortcut',focus:await safeFocus(p)});
 await p.keyboard.press('Escape'); assert.equal(await frame(p).count(),0);
 assert.equal(await toggle(p).evaluate(e=>e===document.activeElement),true);
 cases.push({name:'next Escape closes frame and restores footer'});
 await desktop.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const m=await mobile.newPage(); await m.goto(url);
 await m.getByRole('button',{name:/^Toggle sidebar/}).click(); await toggle(m).waitFor(); await toggle(m).click(); await ready(m);
 await frame(m).locator('[data-guide-page-list-scroll] [aria-current="true"]').focus();
 for(let i=0;i<3;i++){await m.keyboard.press('ArrowRight'); const f=await safeFocus(m); assert(f.inside&&!f.inert); assert.equal(await frame(m).locator('[data-guide-page-list-scroll] [aria-current="true"]').evaluate(e=>e===document.activeElement),true);}
 cases.push({name:'three mobile arrows retain visible page focus',focus:await safeFocus(m)});
 await m.keyboard.press('Tab'); const tabFocus=await safeFocus(m); assert(tabFocus.inside&&!tabFocus.inert); cases.push({name:'mobile Tab retains visible guide focus',focus:tabFocus});
 await m.keyboard.press('Escape'); assert.equal(await frame(m).count(),0); await mobile.close();
 // Override only this ephemeral browser's GET preference response. Never write operator state.
 const overflow=await browser.newContext({viewport:{width:1440,height:1000}});
 let shadowed=0,writes=0;
 await overflow.route('**/api/v1/preferences/ui**',async r=>{
   if(r.request().method()!=='GET'){writes++;return r.abort();}
   const res=await r.fetch();const d=await res.json();
   d.preferences['sidebar.hiddenFooterItems']={revision:100000,value:['plugin:plugin-guide-for-nerds/guide-toggle']};
   shadowed++;await r.fulfill({response:res,json:d});
 });
 const o=await overflow.newPage(); await o.goto(url);
 const more=o.getByRole('button',{name:'More footer actions',exact:true}); await more.waitFor();
 await more.focus(); await o.keyboard.press('Enter');
 const item=o.getByRole('menuitem',{name:'Toggle BB Plugin Guide for Nerds',exact:true}); await item.waitFor(); await item.focus(); await o.keyboard.press('Enter'); await ready(o);
 await item.waitFor({state:'detached'});
 await o.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Close guide', null, {timeout:1500});
 const opened=await safeFocus(o); await o.keyboard.press('Escape');
 cases.push({name:'overflow keyboard open/close',opened,closed:await safeFocus(o),frames:await frame(o).count(),shadowed,writes});
 assert.equal(writes,0);assert.equal(await frame(o).count(),0);
 assert.equal(opened.label,'Close guide'); assert.equal(await more.evaluate(e=>e===document.activeElement),true);
 await overflow.close();
 fs.writeFileSync(out+'/native-review.json',JSON.stringify({observedAt:new Date().toISOString(),browser:browser.version(),cases,build:JSON.parse(fs.readFileSync(root+'/dist/app.meta.json'))},null,2)+'\n');
 console.log('PASS native review: '+cases.map(c=>c.name).join('; '));
} finally {fs.writeFileSync(out+'/native-review-partial.json',JSON.stringify({cases},null,2)+'\n');await browser?.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
