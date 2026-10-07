"""Read retained research inputs; regenerate deterministic inventories/comparisons only."""
import pathlib,re,json,hashlib
P=pathlib.Path(__file__).resolve().parent
REV='129f621771a3e275773992db648316966ac207cf'
def load(p):return json.loads(p.read_text())
def write(n,x):(P/n).write_text(json.dumps(x,indent=2,sort_keys=True)+'\n')
def theme(root):
 css=(root/'apps/app/src/components/ui/theme.css').read_text();out=[]
 for block in re.findall(r'@theme[^\{]*\{([^}]+)\}',css):
  block=re.sub(r'/\*.*?\*/','',block,flags=re.S)
  for name,val in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);',block):
   refs=re.findall(r'var\((--[\w-]+)\)',val);category=name[2:].split('-')[0]
   suffix=name.removeprefix('--color-')
   utilities={'color':[f'bg-{suffix}',f'text-{suffix}',f'border-{suffix}',f'ring-{suffix}'],'font':['font-'+name[7:]],'radius':['rounded-'+name[9:]],'shadow':['shadow'+name[8:]],'text':['text-'+name[7:]]}.get(category,[])
   if '--line-height' in name:utilities=[]
   out.append({'id':name,'bridge':name,'expression':val.strip(),'variables':refs,'category':category,'utilityExamples':utilities,'source':'apps/app/src/components/ui/theme.css'})
 return out
helpers={'activity-row-styles':'style-constants','chrome-style-tokens':'style-constants','coarse-pointer-sizing':'style-constants','coarse-pointer-visibility':'style-constants','motion':'style-constants','menu-item-hover':'interaction-context-hook','overlay-trigger':'interaction-functions','portal-scope':'portal-hook','question-form-host':'host-hook','question-form-state':'state-functions','resource-route-label':'navigation-hook','utils':'utility-functions'}
def registry(root):
 rev=REV if root.name=='release-source' else '9c9bae7f36a237c7e1b96de3d4c2186d13967686'
 d=root/'packages/plugin-registry/r';idx=load(d/'index.json');out=[]
 assert {f.stem for f in d.glob('*.json') if f.stem!='index'}=={i['name'] for i in idx['items']}
 for i in idx['items']:
  j=load(d/(i['name']+'.json'));name=j['name'];helper=helpers.get(name) or ('hook' if j['type']=='registry:hook' else 'utility' if j['type']=='registry:lib' else None)
  out.append({'id':name,'target':'@bb/'+name,'ownership':'source-vendored','registryType':j['type'],'classification':'nonvisual-helper' if helper else 'renderable-source','helperKind':helper,'experimental':'not-declared-by-registry','description':j.get('description'), 'dependencies':j.get('dependencies',[]),'registryDependencies':j.get('registryDependencies',[]),'files':[{'path':f['path'],'target':f.get('target'),'sha256':hashlib.sha256(f['content'].encode()).hexdigest()} for f in j.get('files',[])],'source':f'packages/plugin-registry/r/{name}.json','sourceUrl':f'https://raw.githubusercontent.com/get-bb/bb/{rev}/packages/plugin-registry/r/{name}.json'})
 return out

def host(root):
 s=(root/'packages/plugin-sdk/src/app.ts').read_text()
 return [{'id':n,'importFrom':'@get-bb/plugin-sdk/app','ownership':'sdk-host','experimental':n.startswith('experimental_'),'classification':'renderable-host','source':'packages/plugin-sdk/src/app.ts'} for n in re.findall(r'export const (\w+)\s*=\s*runtimeComponent\(',s)]
def delta(a,b,key='id'):
 aa={x[key]:x for x in a};bb={x[key]:x for x in b};return {'added':sorted(bb.keys()-aa.keys()),'removed':sorted(aa.keys()-bb.keys()),'changed':sorted(k for k in aa.keys()&bb.keys() if {a:v for a,v in aa[k].items() if a!='sourceUrl'}!={a:v for a,v in bb[k].items() if a!='sourceUrl'})}
r=P/'release-source';d=P/'deployed-upstream'
themeR,themeD=theme(r),theme(d);hostR,hostD=host(r),host(d);regR,regD=registry(r),registry(d)
for n,x in [('theme',themeR),('host',hostR),('registry',regR),('deployed-theme',themeD),('deployed-host',hostD),('deployed-registry',regD)]:write(n+'-inventory.json',x)
teach=(P/'teaching/ui-reference.ts').read_text();tokens=re.findall(r'"(--[\w-]+)"',teach.split('export const PUBLIC_THEME_TOKEN_VARIABLES = [')[1].split('] as const')[0]);hosts=re.findall(r'name: "(\w+)"',teach.split('id: "host-experiences"')[1].split('id: "controls-fields"')[0]);regs=[]
for group in ['controls-fields','menus-overlays','layout-navigation','content-feedback']:
 s=teach.split(f'id: "{group}"')[1].split('entries: [')[1].split('].map')[0];regs+=re.findall(r'"([a-z-]+)"',s)
write('teaching-inventory.json',{'themeVariables':tokens,'hostExports':hosts,'registryIds':regs})
colors=[x for x in themeR if x['category']=='color'];varsR={v for x in colors for v in x['variables']};varsD={v for x in themeD if x['category']=='color' for v in x['variables']}
comparison={'deployedToRelease':{'theme':delta(themeD,themeR),'host':delta(hostD,hostR),'registry':delta(regD,regR),'colorTokensUnavailableInDeployedUpstream':sorted(varsR-varsD)},'teachingToRelease':{'themeMissing':sorted(varsR-set(tokens)),'themeStale':sorted(set(tokens)-varsR),'hostMissing':sorted({x['id'] for x in hostR}-set(hosts)),'hostInvalid':sorted(set(hosts)-{x['id'] for x in hostR}),'registryMissing':sorted({x['id'] for x in regR}-set(regs)),'registryInvalid':sorted(set(regs)-{x['id'] for x in regR})},'counts':{'themeBridge':len(themeR),'semanticColorBridge':len(colors),'hostRenderable':len(hostR),'registryAll':len(regR),'registryRenderable':sum(x['classification']=='renderable-source' for x in regR),'registryNonvisual':sum(x['classification']=='nonvisual-helper' for x in regR)}}
# Published package forwarders must cover the source inventory; host implementation must supply each component.
pub=(P/'published/plugin-sdk-0.6.15/dist/app.js').read_text();pubhost=set(re.findall(r'var (\w+) = runtimeComponent\(',pub));assert pubhost=={x['id'] for x in hostR},pubhost
impl=(r/'apps/app/src/lib/plugin-sdk-app-impl.tsx').read_text();assert all(re.search(r'\b'+re.escape(x['id'])+r'\s*:',impl) for x in hostR)
metas=list((P/'published/bb-app-0.45.0').rglob('*.meta.json'));assert metas
assert all(load(f)['sdkVersion']=='0.6.15' and load(f)['builtWith']['bbVersion']=='0.45.0' for f in metas)
write('comparison.json',comparison)
exports=[]
for n,k in re.findall(r'export const (\w+)\s*=\s*(runtimeComponent|runtimeFunction)\(', (r/'packages/plugin-sdk/src/app.ts').read_text()):
 exports.append({'name':n,'classification':'renderable-host' if k=='runtimeComponent' else 'nonvisual-function','experimental':n.startswith('experimental_'),'importFrom':'@get-bb/plugin-sdk/app'})
exports.append({'name':'definePluginApp','classification':'definition-function','experimental':False,'importFrom':'@get-bb/plugin-sdk/app'})
write('app-value-exports.json',exports)
for data in [themeR,hostR,regR]: assert len(data)==len({x['id'] for x in data})
print(json.dumps(comparison,indent=2))
