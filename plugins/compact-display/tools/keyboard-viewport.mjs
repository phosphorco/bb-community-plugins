// Live integration probe; setup matches mobile-inputs.mjs.
// Runs in an ephemeral Playwright context. Drafts are localStorage-only in BB;
// no message is submitted. Keyboard signals are synthetic, not native iOS.
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium,devices}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const out=process.env.BB_EVIDENCE_DIR;await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE,headless:true,args:['--no-sandbox']});
const result={kind:'Live composer with a disposable multiline draft; synthetic visualViewport readings, not a native iOS keyboard or physical pan. Control CSS restores the old compact height cap.',cases:[]};
try {
 const context=await browser.newContext({...devices['iPhone 13'],viewport:{width:390,height:844},deviceScaleFactor:1});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.goto(new URL('/threads/'+process.env.BB_TEST_THREAD,process.env.BB_URL).href,{waitUntil:'domcontentloaded'});
 const editor=page.locator('#thread-detail-follow-up-composer');await editor.waitFor();await page.waitForTimeout(1200);
 assert.equal(await page.locator('.tb-full').count(),0);
 await page.evaluate(()=>{
  window.__keyboardModel={height:844,offsetTop:0,scale:1};
  for(const key of ['height','offsetTop','pageTop','scale'])Object.defineProperty(visualViewport,key,{configurable:true,get:()=>window.__keyboardModel[key==='pageTop'?'offsetTop':key]});
  const label=document.createElement('div');label.id='keyboard-model-label';label.textContent='SYNTHETIC keyboard viewport — disposable draft';
  label.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:3px;font:10px sans-serif;background:#ffedb5;color:#111;pointer-events:none';document.body.append(label);
 });
 const model=async(height,offsetTop=0,scale=1)=>{await page.evaluate(m=>{Object.assign(window.__keyboardModel,m);visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));},{height,offsetTop,scale});await page.waitForTimeout(650);};
 const capture=async name=>{
  const data=await editor.evaluate(e=>{
   const form=e.closest('form'),r=form.getBoundingClientRect(),s=e.closest('[data-promptbox-editor-scroll]'),v=visualViewport,rs=s.getBoundingClientRect();
   const header=document.querySelector('[data-app-header]');
   return {focused:document.activeElement===e,layoutHeight:innerHeight,visualHeight:v.height,visualTop:v.offsetTop,scale:v.scale,composer:{top:r.top,bottom:r.bottom,height:r.height},editorScroll:{height:rs.height,maxHeight:getComputedStyle(s).maxHeight,minHeight:getComputedStyle(s).minHeight,availableHeight:getComputedStyle(s).getPropertyValue('--composer-editor-available-height')},withinVisibleBand:r.top>=v.offsetTop&&r.bottom<=v.offsetTop+v.height,shellHeight:document.body.style.getPropertyValue('--bb-shell-height')};
  });
  result.cases.push({name,...data});await page.screenshot({path:out+'/'+name+'.png'});console.log(name,JSON.stringify(data));return data;
 };
 await editor.fill(Array.from({length:30},(_,i)=>`Disposable viewport probe line ${i+1}`).join('\n'));
 await page.waitForFunction(()=>!!document.querySelector('#thread-detail-follow-up-composer')?.closest('[data-follow-up-composer-expanded]'));
 // Positive cases exercise the installed stylesheet, not a candidate injected by the test.
 for(const height of [500,380,300,250]) {
  await model(height);const sample=await capture(`fixed-height-${height}`);
  assert.ok(sample.focused && sample.withinVisibleBand, `Composer clipped with visual height ${height}`);
 }
 // Preserve the native home composer's potentially smaller available-height budget.
 await page.locator('[data-promptbox-editor-scroll]').evaluate(e=>e.style.setProperty('--composer-editor-available-height','80px'));
 await model(500);const constrained=await capture('native-available-height-80');
 assert.ok(constrained.editorScroll.height<=80, 'Native available-height cap must survive compact overrides');
 await page.locator('[data-promptbox-editor-scroll]').evaluate(e=>e.style.removeProperty('--composer-editor-available-height'));
 // Negative control changes this document only. No plugin is globally disabled.
 const oldRule=await page.addStyleTag({content:'[data-promptbox-editor-scroll] { max-height: calc(30dvh - 3rem) !important; }'});
 for(const height of [300,250]) {
  await model(height);const sample=await capture(`old-rule-height-${height}`);
  assert.equal(sample.withinVisibleBand,false, 'Control must reproduce the old clipping failure');
 }
 await oldRule.evaluate(e=>e.remove());
 // Record this separate limitation; it is not covered by the height-cap fix.
 await model(500,0,1.15);await capture('synthetic-scale-1_15-known-limitation');
 await model(844);await editor.fill('');await editor.evaluate(e=>e.blur());
} catch(e){result.error=String(e.stack||e);throw e;}
finally{await writeFile(out+'/results.json',JSON.stringify(result,null,2));await browser.close();}
