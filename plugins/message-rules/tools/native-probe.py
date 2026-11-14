import json,urllib.request,urllib.error,pathlib,time,argparse
parser=argparse.ArgumentParser();parser.add_argument('--evidence',required=True);parser.add_argument('--project',required=True);parser.add_argument('--base-url',required=True);args=parser.parse_args();r=pathlib.Path(args.evidence);r.mkdir(parents=True,exist_ok=True);project=args.project;trace=[]
def call(method,path,data=None):
 req=urllib.request.Request(args.base_url.rstrip('/')+'/api/v1'+path,None if data is None else json.dumps(data).encode(),{'Content-Type':'application/json'},method=method)
 try:
  resp=urllib.request.urlopen(req);status=resp.status;body=json.load(resp)
 except urllib.error.HTTPError as e:status=e.code;body=json.load(e)
 trace.append({'method':method,'path':path,'input':data,'status':status,'body':body});return status,body
def create(title,parent=None):
 d={'projectId':project,'providerId':'message-rules-proof','model':'inert','reasoningLevel':'low','permissionMode':'auto','origin':'cli','title':title,'input':[{'type':'text','text':'Future scheduled inert capability witness.'}],'environment':{'type':'project-default'},'sendAt':int(time.time()*1000)+86400000}
 if parent:d['parentThreadId']=parent
 status,body=call('POST','/threads',d);assert status==201,body;return body['id']
try:
 a=create('Proof sender A');b=create('Proof sender B');target=create('Mixed sender target')
 status,queue=call('GET','/threads/'+target+'/queued-messages');rows=queue;scheduled=rows[0];call('DELETE','/threads/'+target+'/queued-messages/'+scheduled['id']);status,first=call('POST','/threads/'+target+'/queued-messages',{'model':'inert','reasoningLevel':'low','permissionMode':'auto','input':[{'type':'text','text':'Original A1'}],'senderThreadId':a});assert status==201,first
 status,q2=call('POST','/threads/'+target+'/queued-messages',{'model':'inert','reasoningLevel':'low','permissionMode':'auto','input':[{'type':'text','text':'Original A2'}],'senderThreadId':a});assert status==201,q2
 status,control=call('PATCH','/threads/'+target+'/queued-messages/group-boundary',{'expectedGroupedPrefixQueuedMessageIds':[first['id'],q2['id']],'groupBoundaryQueuedMessageId':q2['id']});assert status==200,control
 status,q3=call('POST','/threads/'+target+'/queued-messages',{'model':'inert','reasoningLevel':'low','permissionMode':'auto','input':[{'type':'text','text':'Original B3'}],'senderThreadId':b});assert status==201,q3
 status,mixed=call('PATCH','/threads/'+target+'/queued-messages/group-boundary',{'expectedGroupedPrefixQueuedMessageIds':[first['id'],q2['id'],q3['id']],'groupBoundaryQueuedMessageId':q3['id']});assert status==409 and 'different senders cannot be grouped' in mixed.get('message',''),(status,mixed)
 call('GET','/threads/'+target+'/queued-messages')
 result={'harness':'passed','fullDelivery':'failed','reason':'Native public grouping rejects original messages from different senders. Same-sender control succeeds; no aggregate or prefix substitution.','trace':trace}
except Exception as e:result={'harness':'failed','error':str(e),'trace':trace}
(r/('native-capability-'+str(time.time_ns())+'.json')).write_text(json.dumps(result,indent=2));(r/'native-capability.json').write_text(json.dumps(result,indent=2));print({k:v for k,v in result.items() if k!='trace'})
