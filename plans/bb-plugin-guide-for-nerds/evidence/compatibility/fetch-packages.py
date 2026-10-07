import urllib.request,json,pathlib,hashlib,base64,tarfile,sys
root=pathlib.Path(__file__).parent; scratch=pathlib.Path(sys.argv[1]); receipts=[]
for stem in ['get-bb-plugin-sdk-0.4.47','get-bb-plugin-sdk-0.5.29','get-bb-plugin-sdk-0.6.23','bb-app-0.42.0','bb-app-0.44.0']:
 meta=json.loads((root/'registry'/f'{stem}.json').read_text()); data=urllib.request.urlopen(meta['dist']['tarball']).read(); actual='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode(); assert actual==meta['dist']['integrity']; archive=scratch/f'{stem}.tgz'; archive.write_bytes(data); dest=scratch/stem; dest.mkdir(exist_ok=True)
 with tarfile.open(archive) as tar: tar.extractall(dest,filter='data')
 receipts.append({'name':meta['name'],'version':meta['version'],'gitHead':meta.get('gitHead'),'tarball':meta['dist']['tarball'],'integrity':actual,'sha256':hashlib.sha256(data).hexdigest()}); print(stem,len(data),flush=True)
(pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else root/'package-provenance.json').write_text(json.dumps(receipts,indent=2)+'\n')
