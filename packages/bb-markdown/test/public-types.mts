import { MarkdownRequestSchema, MarkdownTreeSchema, createLiteralMarkdown, type MarkdownSource, type MarkdownRequest, type MarkdownNode, type PreparedMarkdown } from '../src/index.js';
import { createMarkdownOwner, type MarkdownSdk, type MarkdownOwner } from '../src/server.js';
const source: MarkdownSource={kind:'thread-message',instance:'local',threadId:'thr_23456789ab',messageId:'message:42',revision:'1'};
const request: MarkdownRequest={source,intent:'prose',content:'hello'};
const fallback: PreparedMarkdown=createLiteralMarkdown(request);
const code: MarkdownNode={kind:'element',tag:'code',children:[{kind:'text',value:'/outside/file.ts'}]};
MarkdownRequestSchema.parse(request);MarkdownTreeSchema.parse({version:1,children:[code]});
declare const sdk:MarkdownSdk;
const owner:MarkdownOwner=createMarkdownOwner({sdk,consumer:{pluginId:'pilot',surface:'latest'}});
void owner.prepare({phase:'base',requests:[request]});void fallback.tree;owner.invalidate();owner.dispose();
// @ts-expect-error source provenance is mandatory
const missingSource:MarkdownRequest={intent:'prose',content:'x'};
// @ts-expect-error arbitrary rendering exemptions are not public intents
const wrongIntent:MarkdownRequest={source,intent:'literal',content:'x'};
// @ts-expect-error detached sources never manufacture a local frame
const foreign:MarkdownSource={kind:'detached',origin:'local',producer:'x',sourceKey:'k',revision:'1'};
// @ts-expect-error tags and attributes are reviewed data, never arbitrary HTML
const dangerous:MarkdownNode={kind:'element',tag:'script',children:[],onClick:'run()'};
const localImage:MarkdownNode={kind:'local-image',target:{kind:'workspace',environmentId:'env_source',path:'images/a.png'},alt:'image'};
void [missingSource,wrongIntent,foreign,dangerous,localImage];
