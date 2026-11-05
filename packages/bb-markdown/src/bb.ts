/** Plugin-local registration. No service, cross-plugin registry or product backend. */
import { defineRpcContract, type BbPluginApi, type StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { MarkdownPrepareInputSchema, MarkdownPrepareOutputSchema, type MarkdownPrepareInput, type PreparedMarkdown } from './index.js';
import { createMarkdownOwner, type MarkdownOwnerOptions } from './server.js';
function sdkSchema<T>(schema:z.ZodType<T>):StandardSchemaV1<T> {
  return {'~standard':{version:1,vendor:'bb-markdown',
    jsonSchema:{input:()=>schema.toJSONSchema({io:'input',unrepresentable:'any'}),output:()=>schema.toJSONSchema({io:'output',unrepresentable:'any'})},
    validate(value){const parsed=schema.safeParse(value);return parsed.success?{value:parsed.data}:{issues:parsed.error.issues.map(issue=>({message:issue.message,path:issue.path}))};},
  }};
}
export const markdownRpcContract=defineRpcContract({
  markdownPrepareV1:{input:sdkSchema<MarkdownPrepareInput>(MarkdownPrepareInputSchema),output:sdkSchema<PreparedMarkdown[]>(MarkdownPrepareOutputSchema)},
  markdownInvalidateV1:{input:sdkSchema(z.object({}).strict()),output:sdkSchema(z.object({ok:z.literal(true)}).strict())},
});
/** Call once in each consuming plugin factory; surface leaves share this owner. */
export interface MarkdownPluginApi {
  sdk:MarkdownOwnerOptions['sdk'];
  server:Pick<BbPluginApi['server'],'experimental_appUrl'>;
  onDispose(handler:()=>void|Promise<void>):void;
  rpc:{register(contract:typeof markdownRpcContract,handlers:{
    markdownPrepareV1(input:MarkdownPrepareInput):Promise<PreparedMarkdown[]>;
    markdownInvalidateV1(input:Record<string,never>):{ok:true};
  }):void};
}
export function registerMarkdown(bb:MarkdownPluginApi,options:{consumer:MarkdownOwnerOptions['consumer']}) {
  const owner=createMarkdownOwner({sdk:bb.sdk,consumer:options.consumer,...(bb.server.experimental_appUrl?{publicOrigin:bb.server.experimental_appUrl}:{})});
  bb.rpc.register(markdownRpcContract,{
    markdownPrepareV1:async input=>MarkdownPrepareOutputSchema.parse(await owner.prepare(input)),
    markdownInvalidateV1:()=>{owner.invalidate();return {ok:true as const};},
  });
  bb.onDispose(()=>owner.dispose());
  return owner;
}
