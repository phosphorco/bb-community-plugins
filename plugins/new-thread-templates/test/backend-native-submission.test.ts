import {test,expect} from 'bun:test';
import type {NewThreadRequest} from '@get-bb/plugin-sdk/app';
import {nativeSubmissionSchema,decodeNativeSubmission,publicNativeSubmission,publicNativeSpawn,type NativeSubmission} from '../native-submission';
import {nativeRequestSchema} from '../native';

import {nativeSubmission} from './backend-fixtures';

test('native DTO retains public structured resources, attachments, optional scheduling and execution provenance without flattening',()=>{
  const submission=nativeSubmission();submission.sendAt=1900000000000;
  const actualPublic:NewThreadRequest=publicNativeSubmission(submission);
  expect(decodeNativeSubmission(actualPublic)).toEqual(submission);
  const spawn=publicNativeSpawn(submission);expect(spawn).toEqual(submission);
  expect(nativeRequestSchema.parse({...submission,title:'Original generated title',pluginMetadata:{operationId:'op'}}).input).toEqual(submission.input);
  const resources:NativeSubmission['input']=[{type:'text',text:'abcdefg',mentions:[
    {start:0,end:1,resource:{kind:'project',label:'p',projectId:'p'}},
    {start:1,end:2,resource:{kind:'section',label:'s',sectionId:'s'}},
    {start:2,end:3,resource:{kind:'path',label:'file',path:'src/a.ts',source:'workspace',entryKind:'file'}},
    {start:3,end:4,resource:{kind:'path',label:'dir',path:'notes',source:'thread-storage',entryKind:'directory'}},
    {start:4,end:5,resource:{kind:'plugin',label:'item',pluginId:'plugin',itemId:'item',icon:null}},
    {start:5,end:6,resource:{kind:'attachment',label:'a',path:'/a'}},
    {start:6,end:7,resource:{kind:'command',label:'c',name:'c',argumentHint:'args',origin:'builtin',source:'command',trigger:'$'}},
  ]},{type:'image',url:'https://example.com/image.png'}];
  expect(decodeNativeSubmission({...actualPublic,input:resources}).input).toEqual(resources);
  expect(nativeSubmissionSchema.parse({...submission,sendAt:undefined})).not.toHaveProperty('prompt');
});

test('all public native environment branches round-trip without source path or branch substitution',()=>{
  const environments:NewThreadRequest['environment'][]=[
    {type:'project-default'}, {type:'reuse',environmentId:'env'},
    {type:'host',workspace:{type:'unmanaged',path:null}},
    {type:'host',hostId:'h',workspace:{type:'unmanaged',path:'/actual/path',branch:{kind:'existing',name:'topic'}}},
    {type:'host',workspace:{type:'managed-worktree',baseBranch:{kind:'default'}}},
    {type:'host',hostId:'h',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:'release'}}},
    {type:'host',workspace:{type:'personal'}},
    {type:'provider',environmentProviderId:'container',inputs:{image:'image'},machine:{type:'existing',hostId:'h'}},
    {type:'provider',environmentProviderId:'cloud',inputs:null,machine:{type:'new',machineProviderId:'vm',inputs:{region:'west'}}},
    {type:'provider',environmentProviderId:'composition',inputs:[true,'custom']},
  ];
  for(const environment of environments)expect(decodeNativeSubmission({...publicNativeSubmission(nativeSubmission()),environment}).environment).toEqual(environment);
});

test('malformed mention bounds/resources, fractional schedule and excessive serialized input fail before a native claim',()=>{
  const s=nativeSubmission();
  for(const input of [
    [{type:'text',text:'short',mentions:[{start:0,end:20,resource:{kind:'thread',label:'x',threadId:'x'}}]}],
    [{type:'text',text:'short',mentions:[{start:1,end:3,resource:{kind:'thread',label:'x',threadId:'x'}},{start:2,end:4,resource:{kind:'thread',label:'x',threadId:'x'}}]}],
    [{type:'text',text:'short',mentions:[{start:0,end:3,resource:{kind:'path',label:'x',path:'x',source:'arbitrary',entryKind:'file'}}]}],
    [{type:'text',text:'   ',mentions:[]}],
    Array.from({length:5},()=>({type:'text',text:'x'.repeat(250000),mentions:[]})),
  ])expect(nativeSubmissionSchema.safeParse({...s,input}).success).toBe(false);
  expect(nativeSubmissionSchema.safeParse({...s,sendAt:123.5}).success).toBe(false);
  expect(nativeSubmissionSchema.safeParse({...s,unexpected:'unsupported'}).success).toBe(false);
});
