import urllib.request,json,pathlib,tarfile,io,hashlib,base64,concurrent.futures
ROOT=pathlib.Path(__file__).resolve().parent

def fetch(url,path):
 data=urllib.request.urlopen(url).read();p=ROOT/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return data

def unpack(data,dest,predicate):
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
  for m in t:
   rel='/'.join(m.name.split('/')[1:])
   if m.isfile() and predicate(rel):
    p=ROOT/dest/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(t.extractfile(m).read())
meta=json.loads((ROOT/'npm/bb-app-metadata.json').read_text());v=meta['dist-tags']['latest'];bb=meta['versions'][v];rev=bb['gitHead']
data=fetch(f'https://codeload.github.com/get-bb/bb/tar.gz/{rev}','archives/release-source.tgz')
prefixes=['packages/plugin-sdk/','packages/plugin-registry/','packages/plugin-build/']
exact=['apps/app/src/components/ui/theme.css','apps/app/src/lib/plugin-sdk-app.ts','packages/bb-app/package.json','packages/cli/package.json','LICENSE','pnpm-lock.yaml']
unpack(data,'release-source',lambda s:any(s.startswith(x) for x in prefixes) or s in exact or 'plugin-sdk' in s and s.startswith('apps/app/'))
sdkversion=json.loads((ROOT/'release-source/packages/plugin-sdk/package.json').read_text())['version'];print('RELEASE',v,rev,'SDK',sdkversion)
sdkmeta=json.loads((ROOT/'npm/plugin-sdk-metadata.json').read_text())
receipt={'bb':{'version':v,'gitHead':rev,'publishedAt':meta['time'][v],'dist':bb['dist']},'sdkAtReleaseSource':sdkversion,'packages':[]}
for name,version,j in [('bb-app',v,bb),('@get-bb/plugin-sdk',sdkversion,sdkmeta['versions'][sdkversion]),('@get-bb/plugin-sdk','0.5.29',sdkmeta['versions']['0.5.29']),('@get-bb/plugin-sdk','0.4.47',sdkmeta['versions']['0.4.47'])]:
 slug=name.split('/')[-1]+'-'+version
 data=fetch(j['dist']['tarball'],'archives/'+slug+'.tgz')
 integrity='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode();assert integrity==j['dist']['integrity']
 (ROOT/'npm'/f'{slug}.json').write_text(json.dumps(j,indent=2)+'\n')
 unpack(data,'published/'+slug,lambda s:name!='bb-app' or s=='package.json' or 'plugin-sdk' in s or 'registry' in s or s.endswith('.css') or 'plugin-build' in s)
 receipt['packages'].append({'name':name,'version':version,'gitHead':j.get('gitHead'),'dist':j['dist'],'integrityVerified':True})
(ROOT/'release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
