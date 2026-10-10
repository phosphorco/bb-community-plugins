#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const name = process.argv[3]?.match(/mcp_servers\.([\w-]+)/)?.[1] ?? 'figma';
const args = process.argv.slice(2);
let catalogs = 0;
const send = v => process.stdout.write(JSON.stringify(v) + '\n');
const audit = v => appendFileSync('codex-audit.jsonl', JSON.stringify(v) + '\n');
if (args.includes('login')) {
  audit({login:true,args});
  if (name === 'authfail') { process.stderr.write('secret-callback-code secret-token\n'); process.exit(1); }
  const url = 'https://www.figma.com/oauth/mcp?redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2Fcallback&state=test-state&scope=mcp%3Aconnect';
  process.stderr.write('Authorize using browser:\n' + url.slice(0, 57));
  setTimeout(() => { process.stderr.write(url.slice(57) + '\nPaste callback URL: '); if(name==='directauth') setTimeout(()=>process.exit(0),50); if(name==='authflood') setTimeout(()=>process.stderr.write('x'.repeat(70000)),20); }, 5);
  createInterface({input:process.stdin}).on('line', value => {
    const callback = new URL(value);
    const good = name !== 'authreject' && callback.origin === 'http://127.0.0.1:45678' && callback.pathname === '/callback' && callback.searchParams.get('state') === 'test-state' && callback.searchParams.get('code') === 'secret-code' && callback.searchParams.get('iss') === 'https://api.figma.com';
    process.exit(good ? 0 : 1);
  });
} else {
  audit({spawn: true,args});
  createInterface({input:process.stdin}).on('line', line => {
    const v = JSON.parse(line);
    audit({method:v.method, ...(v.method === 'initialize' || v.method === 'thread/start' ? {params:v.params} : {})});
    if (!v.method || v.id === undefined) return;
    const result = result => send({id:v.id,result});
    if(v.method === 'initialize') return result({userAgent:'fixture'});
    if(v.method === 'thread/start') {
      if(name === 'startfail') return send({id:v.id,error:{code:-32000,message:'secret-token'}});
      if(name === 'slowstart') return setTimeout(() => result({thread:{id:'thread-fixture'}}),500);
      return result({thread:{id:'thread-fixture'}});
    }
    if(v.method === 'mcpServerStatus/list') {
      catalogs++;
      if(name === 'pagination' && !v.params.cursor) return result({data:[],nextCursor:'page2'});
      if(name === 'loop') return result({data:[],nextCursor:'page2'});
      return result({data:[{name,authStatus:name==='noauth'?'notLoggedIn':'oAuth',runtimeStatus:name==='initializing' && catalogs===1?'starting':'connected',httpOrigin:'https://mcp.figma.com',toolsError:name==='toolserror'?'secret-token':null,
        serverInfo:{name:'figma',version:'test'},serverCapabilities:{tools:{listChanged:true},resources:{subscribe:true,listChanged:true},prompts:{},logging:{}},
        tools:{whoami:{name:'whoami',title:'Identity',description:'Who',inputSchema:{type:'object'},outputSchema:{type:'object'},annotations:{readOnlyHint:true},_meta:{custom:'retained'},icons:[{src:'https://example.test/icon'}],extension:'retained'}},
        resources:[{uri:'figma://test',name:'test',annotations:{audience:['assistant']},extension:'kept'}],resourceTemplates:[{name:'template',uriTemplate:'figma://{file}',extension:'kept'}]}],nextCursor:null});
    }
    if(v.method==='mcpServer/resource/read') return result({contents:[{uri:v.params.uri,text:'resource',mimeType:'text/plain',_meta:{custom:1}}],extension:'retained'});
    if(v.method==='mcpServer/tool/call') {
      const a=v.params.arguments??{};
      if(a.crash) return process.exit(1);
      if(a.invalidparams) return send({id:v.id,error:{code:-32602,message:'Invalid nodeId: 12:34'}});
      if(a.internal) return send({id:v.id,error:{code:-32603,message:'tool call failed: timed out waiting for tools/call after 180s'}});
      if(a.protocol) return send({id:v.id,error:{code:-32001,message:'Invalid nodeId: 12:34. Bearer secret-token; code=secret-callback-code',data:{secret:'secret-token'}}});
      if(a.starting) send({method:'mcpServer/startupStatus/updated',params:{name,status:'starting',threadId:'thread-fixture'}});
      if(a.connected) send({method:'mcpServer/startupStatus/updated',params:{name,status:'ready',threadId:'thread-fixture'}});
      if(a.elicit) send({id:'approval-1',method:'mcpServer/elicitation/request',params:{}});
      if(a.change) send({method:'mcpServer/startupStatus/updated',params:{name,status:'failed',error:'secret-token',threadId:'thread-fixture'}});
      if(a.hang) return;
      setTimeout(() => result({content:[{type:'text',text:a.timeout?'timed out waiting for tools/call after 180s':'one'},{type:'image',mimeType:'image/png',data:'aW1hZ2U='},{type:'resource_link',uri:'figma://test',name:'test'}],structuredContent:{ok:true},isError:!!a.error || !!a.timeout,_meta:{custom:'kept'},extension:'retained'}),a.delay??0);
      return;
    }
    send({id:v.id,error:{code:-32601,message:'unknown'}});
  });
}
