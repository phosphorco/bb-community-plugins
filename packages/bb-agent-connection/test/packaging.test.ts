import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
test('emitted public entries import; pure entries exclude React/SDK and DOM',async()=>{
 for(const entry of ['index','client','bb','react','testing']){expect(await import(`../dist/${entry}.js`)).toBeDefined();expect(readFileSync(new URL(`../dist/types/${entry}.d.ts`,import.meta.url),'utf8').length).toBeGreaterThan(0);}
 for(const entry of ['index','client','bb','testing']){const js=readFileSync(new URL(`../dist/${entry}.js`,import.meta.url),'utf8');expect(js).not.toMatch(/from ["'](?:react|react-dom|jsdom|@get-bb\/plugin-sdk)/);expect(js).not.toMatch(/useRpc|useSettings|experimental_usePluginId/);}
 const root=readFileSync(new URL('../dist/index.js',import.meta.url),'utf8');expect(root).not.toMatch(/bb-identity|document\.|window\./);
 const kit=readFileSync(new URL('../dist/testing.js',import.meta.url),'utf8');expect(kit).toContain('./index.js');
});
