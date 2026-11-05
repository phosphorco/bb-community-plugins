import assert from 'node:assert/strict';
import test from 'node:test';
import {githubLookup,recognitionIdentity} from '../dist/index.js';
test('documented explicit URL codec preserves root identity and distinguishes PR authority from issue',()=>{
 const root=githubLookup('https://github.com/Owner/Repo/pull/42');assert.equal(root.query.relation,'github-pr-family');
 for(const tail of ['#issuecomment-123','/files#discussion_r123','#pullrequestreview-42'])assert.deepEqual(githubLookup('https://github.com/owner/repo/pull/42'+tail).query.target,root.query.target);
 assert.deepEqual(root.query.target,recognitionIdentity({provider:'github',id:'github.com/owner/repo#42'}));
 assert.equal(githubLookup('https://github.com/owner/repo/issues/42').query.relation,'self');
 for(const value of ['owner/repo#42','#42','https://evil.test/owner/repo/pull/42','https://github.com/owner/repo/pull/0','https://user:pass@github.com/owner/repo/pull/42','https://github.com/owner/repo/pull/42?token=secret'])assert.equal(githubLookup(value),null);
});
