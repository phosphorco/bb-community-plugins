import pathlib,tempfile,subprocess,shutil,json,os
repo=pathlib.Path('/home/ubuntu/bb/community-plugins');out=repo/'plans/bb-plugin-guide-for-nerds/evidence/review'
scratch=pathlib.Path(tempfile.mkdtemp(prefix='nerd-guide-repo-check-'));results=[]
try:
    env=dict(os.environ,npm_config_cache=str(scratch/'cache'))
    with (out/'final-community-checks.log').open('w') as log:
        setup=subprocess.run(['npm','install','--prefix',str(scratch/'tools'),'--ignore-scripts','--no-audit','--no-fund','npm@11.16.0'],stdout=log,stderr=subprocess.STDOUT,env=env)
        assert setup.returncode==0
        npm=['node',str(scratch/'tools/node_modules/npm/bin/npm-cli.js')]
        for name,args in [('tests',['run','test']),('typecheck',['run','typecheck']),('build',['run','build'])]:
            result=subprocess.run(npm+args,cwd=repo,stdout=log,stderr=subprocess.STDOUT,env=env)
            results.append({'check':name,'exit':result.returncode});print(name,result.returncode,flush=True)
            if name=='unused-install' and result.returncode: break
        # Shared builds can overwrite this plugin's selected lazy output. Restore
        # its explicitly selected builder and reload only this plugin.
        if results and all(r['exit']==0 for r in results):
            env['BB_GUIDE_FORK_CLI']='/home/ubuntu/bb/fork/build/bb/packages/bb-app/host-daemon/dist/bb'
            for name,args in [('selected-lazy-build',['run','build:lazy','--workspace','@phosphorco/bb-plugin-plugin-guide-for-nerds']),('selected-lazy-proof',['run','check:lazy-build','--workspace','@phosphorco/bb-plugin-plugin-guide-for-nerds'])]:
                result=subprocess.run(npm+args,cwd=repo,stdout=log,stderr=subprocess.STDOUT,env=env);results.append({'check':name,'exit':result.returncode});print(name,result.returncode,flush=True)
    (out/'final-community-checks.json').write_text(json.dumps({'npmVersion':'11.16.0','checks':results,'scratchRetired':True},indent=2)+'\n')
finally: shutil.rmtree(scratch)
if any(r['exit'] for r in results): raise SystemExit(1)
