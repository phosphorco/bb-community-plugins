const fs=require('node:fs'),{createRequire}=require('node:module');const {chromium}=createRequire('/home/ubuntu/bb/community-plugins/plugins/analytics/package.json')('playwright');
const report={cases:[]};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});report.browser=browser.version();try{
for(const scenario of ['no-markers','markers-before-first','markers-before-second','long-first-delay']){const prevent=true,delay=scenario==='long-first-delay'?1000:100;
 const ctx=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});const p=await ctx.newPage();
 await p.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><div id="frame" style="position:fixed;left:8px;top:68px;width:374px;height:720px;display:grid;grid-template-rows:62px minmax(0,1fr)"><div id="header" style="touch-action:none;display:flex;align-items:center;padding:8px 10px;border:1px solid"><span style="flex:1">Movable header</span><button id="move" style="width:44px;height:44px;margin-right:8px">↔</button><button id="close" style="width:44px;height:44px"><span>×</span></button></div><div id="scroll" style="overflow:auto;overscroll-behavior:contain"><div style="height:900px">Content</div></div></div>`);
 await p.evaluate(prevent=>{
  window.trace=[];window.__didClose=false;const frame=document.getElementById('frame'),header=document.getElementById('header'),close=document.getElementById('close');let drag=null;
  for(const type of ['pointerdown','pointerup','touchstart','touchend','click'])document.addEventListener(type,e=>window.trace.push({type,target:e.target.tagName,id:e.target.id,time:e.timeStamp,prevented:e.defaultPrevented}),true);
  header.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;if(prevent)e.preventDefault();e.stopPropagation();header.setPointerCapture(e.pointerId);drag={id:e.pointerId,y:e.clientY,top:parseFloat(frame.style.top)};});
  header.addEventListener('pointermove',e=>{if(drag&&e.pointerId===drag.id)frame.style.top=drag.top+e.clientY-drag.y+'px';});
  header.addEventListener('pointerup',e=>{if(drag&&e.pointerId===drag.id){drag=null;if(header.hasPointerCapture(e.pointerId))header.releasePointerCapture(e.pointerId);}});
  close.addEventListener('click',()=>{window.__didClose=true;frame.remove();});
 },prevent);
 const cdp=await ctx.newCDPSession(p);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:68,y:88}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:68,y:128}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await p.setViewportSize({width:320,height:568});await p.evaluate(()=>{const f=document.getElementById('frame');f.style.top='8px';f.style.width='304px';f.style.height='552px';document.getElementById('scroll').scrollTop=200;});
 await p.waitForTimeout(delay);if(scenario==='markers-before-first')await p.locator('#frame').evaluate(e=>{e.setAttribute('data-no-sidebar-swipe','');e.setAttribute('data-no-secondary-panel-swipe','');});await p.locator('#close').tap();await p.waitForTimeout(500);
 const first=await p.evaluate(()=>({closed:window.__didClose,trace:window.trace}));let second=null;
 if(!first.closed){if(scenario==='markers-before-second')await p.locator('#frame').evaluate(e=>{e.setAttribute('data-no-sidebar-swipe','');e.setAttribute('data-no-secondary-panel-swipe','');});await p.evaluate(()=>window.trace=[]);await p.locator('#close').tap();await p.waitForTimeout(500);second=await p.evaluate(()=>({closed:window.__didClose,trace:window.trace}));}
 report.cases.push({scenario,prevent,delay,first,second});console.log(JSON.stringify({scenario,firstClosed:first.closed,firstClicks:first.trace.filter(x=>x.type==='click').length,secondClosed:second?.closed,secondClicks:second?.trace.filter(x=>x.type==='click').length}));await ctx.close();
}}finally{fs.writeFileSync(process.env.BB_THREAD_STORAGE+'/touch-close-marker-retap.json',JSON.stringify(report,null,2));await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
