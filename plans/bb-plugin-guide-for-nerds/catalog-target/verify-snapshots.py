"""Offline verification of all retained catalog-target evidence bytes."""
import hashlib,pathlib,json
p=pathlib.Path(__file__).resolve().parent
j=json.loads((p/'SNAPSHOTS.json').read_text())
for r in j['files']:
 f=p/r['path'];assert f.is_file(),r['path'];assert hashlib.sha256(f.read_bytes()).hexdigest()==r['sha256'],r['path']
actual={str(f.relative_to(p)) for f in p.rglob('*') if f.is_file() and f.name not in ['SNAPSHOTS.json','SHA256SUMS']}
assert actual=={r['path'] for r in j['files']},'missing or unrecorded research file'
print(f"Verified {len(j['files'])} research files; SNAPSHOTS.json sha256="+hashlib.sha256((p/'SNAPSHOTS.json').read_bytes()).hexdigest())
