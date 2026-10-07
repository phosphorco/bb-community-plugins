#!/usr/bin/env python3
"""Exact public SDK snapshot, isolated signature/harness proof; no installs/builds."""
import base64, hashlib, json, os, pathlib, shutil, subprocess, tarfile, tempfile, urllib.request
here=pathlib.Path(__file__).resolve().parent
workspace=here.parents[4]
modules=workspace/'community-plugins/node_modules'
url='https://registry.npmjs.org/@get-bb%2fplugin-sdk/0.5.29'
expected='sha512-eRIUeZUu3Q4gESo10ajF58yd32+6QdKRGJMPz2/WjxK7DAGNfY5kO2ZAKP+pWS7Bo1l92GrlcO29C15CCvg1aA=='
with tempfile.TemporaryDirectory(prefix='nerd-overlay-sdk-proof-',dir='/tmp') as folder:
 scratch=pathlib.Path(folder)
 metadata=json.load(urllib.request.urlopen(url))
 raw=urllib.request.urlopen(metadata['dist']['tarball']).read()
 actual='sha512-'+base64.b64encode(hashlib.sha512(raw).digest()).decode()
 assert actual==expected==metadata['dist']['integrity']
 archive=scratch/'sdk.tgz';archive.write_bytes(raw)
 package=scratch/'node_modules/@get-bb/plugin-sdk';package.mkdir(parents=True)
 with tarfile.open(archive) as tar:
  for member in tar.getmembers():
   if not member.isfile():continue
   rel=pathlib.PurePosixPath(member.name).relative_to('package');assert '..' not in rel.parts
   dst=package/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(tar.extractfile(member).read())
 for name in ['react','react-dom','zod','@testing-library','@types']:
  (scratch/'node_modules'/name).symlink_to(modules/name,target_is_directory=True)
 (scratch/'package.json').write_text('{"type":"module"}\n')
 for name in ['contract.ts','wiring.tsx']:shutil.copyfile(here/name,scratch/name)
 declaration=package/'bundled-types/bb-plugin-sdk-app.d.ts'
 lines=declaration.read_text().splitlines()
 spans=[(16820,16830),(17404,17422),(17623,17651),(18632,18654),(19930,19958)]
 (here/'public-sdk-excerpts.txt').write_text('\n\n'.join('\n'.join(f'{i+1}: {lines[i]}' for i in range(a-1,b)) for a,b in spans)+'\n')
 record={'registryUrl':url,'version':metadata['version'],'gitHead':metadata.get('gitHead'),'tarball':metadata['dist']['tarball'],'integrity':actual,'integrityVerified':True,'declarationSha256':hashlib.sha256(declaration.read_bytes()).hexdigest(),'scratchPolicy':'unique /tmp directory; removed on success or failure; no shared installs'}
 (here/'public-sdk.json').write_text(json.dumps(record,indent=2)+'\n')
 env={**os.environ,'ADAPTER_SDK_PACKAGE':str(package)}
 commands=[('typecheck-output.txt',[str(modules/'.bin/tsc'),'--noEmit','--strict','--skipLibCheck','--types','react','--module','NodeNext','--moduleResolution','NodeNext','--jsx','react-jsx',str(scratch/'contract.ts'),str(scratch/'wiring.tsx')]),('sdk-harness-output.txt',['node','--test',str(here/'sdk-harness.test.mjs')]),('probe-output.txt',['node','--test',str(here/'probe.test.mjs')])]
 statuses=[]
 for file,command in commands:
  with (here/file).open('w') as log:
   result=subprocess.run(command,cwd=scratch,env=env,stdout=log,stderr=subprocess.STDOUT)
  statuses.append({'output':file,'exitCode':result.returncode,'command':[part.replace(str(scratch),'<unique-scratch>') for part in command]});print(file,result.returncode,flush=True)
 (here/'verification-status.json').write_text(json.dumps(statuses,indent=2)+'\n')
 assert all(s['exitCode']==0 for s in statuses),statuses
