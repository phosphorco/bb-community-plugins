const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {chromium}=createRequire('/home/ubuntu/bb/community-plugins/plugins/analytics/package.json')('playwright');
const out=process.env.BB_THREAD_STORAGE;const route=new URL('/projects/proj_t8x9yhwnvc/threads/thr_pk5kwrdyjm',process.env.BB_SERVER_URL).href;
const report={date:new Date().toISOString(),cases:[]};const frame=p=>p.getByRole('dialog',{name:'BB Plugin Guide for Nerds',exact:true});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});report.browser=browser.version();
try{for(const scenario of ['drag-resize-scroll']){
 const ctx=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});const p=await ctx.newPage();
 await p.addInitScript(()=>{
  window.__events=[];window.__preventions=[];
  const identify=e=>e instanceof Element?{tag:e.tagName,label:e.getAttribute('aria-label'),cls:e.className,html:e.outerHTML.slice(0,350)}:String(e);
  const prevent=Event.prototype.preventDefault;
  Event.prototype.preventDefault=function(){window.__preventions.push({type:this.type,target:identify(this.target),stack:new Error().stack});return prevent.call(this)};
  for(const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','touchstart','touchmove','touchend','click'])document.addEventListener(type,e=>{
   const record={type,target:identify(e.target),path:e.composedPath().slice(0,6).map(identify),x:e.clientX,y:e.clientY,id:e.pointerId,time:e.timeStamp,prevented:e.defaultPrevented,touches:e.touches?.length};window.__events.push(record);queueMicrotask(()=>record.finalPrevented=e.defaultPrevented);
  },true);
 });
 await p.goto(route,{waitUntil:'domcontentloaded'});await p.getByRole('button',{name:/^Toggle sidebar/}).first().tap();
 await p.getByRole('button',{name:'Toggle BB Plugin Guide for Nerds',exact:true}).tap();await frame(p).locator('[data-guide-content]').waitFor();
 if(scenario.includes('drag')){const cdp=await ctx.newCDPSession(p),h=await frame(p).locator('[data-guide-drag-header]').boundingBox();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:h.x+60,y:h.y+20}]});for(const dy of [28,36,44,52,60]){await p.waitForTimeout(40);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:h.x+60,y:h.y+dy}]});}await p.waitForTimeout(40);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 if(scenario.includes('resize')){await p.setViewportSize({width:320,height:568});await p.waitForTimeout(100);await frame(p).locator('[data-guide-stage-viewport]').evaluate(e=>e.scrollTop=200);}
 const close=frame(p).getByRole('button',{name:'Close guide',exact:true}),box=await close.boundingBox();
 const before=await p.evaluate(({x,y})=>({events:window.__events,preventions:window.__preventions,hit:document.elementsFromPoint(x,y).slice(0,5).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),cls:e.className})),visual:{width:innerWidth,height:innerHeight,scale:visualViewport.scale},button:document.querySelector('[aria-label="Close guide"]').outerHTML}),{x:box.x+box.width/2,y:box.y+box.height/2});
 await p.evaluate(()=>{window.__events=[];window.__preventions=[];});await close.tap();await p.waitForTimeout(400);
 const first={present:await frame(p).count(),trace:await p.evaluate(()=>({events:window.__events,preventions:window.__preventions}))};
 await p.screenshot({path:path.join(out,`touch-close-native-paced-${scenario}.png`)});
 let second=null;if(first.present){await p.evaluate(()=>{window.__events=[];window.__preventions=[];});await close.tap();await p.waitForTimeout(400);second={present:await frame(p).count(),trace:await p.evaluate(()=>({events:window.__events,preventions:window.__preventions}))};}
 report.cases.push({scenario,box,before,first,second});console.log(JSON.stringify({scenario,first:first.present,second:second?.present,events:first.trace.events.map(x=>({type:x.type,target:x.target,prevented:x.finalPrevented})),preventions:first.trace.preventions}));await ctx.close();
}}finally{fs.writeFileSync(path.join(out,'touch-close-native-paced.json'),JSON.stringify(report,null,2));await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
