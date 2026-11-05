/** Documented GitHub locator codec, not a prose recognizer or network resolver.
 * Current supplier maps all PR URL descendants to github.com/owner/repo#number.
 * Kind and authored href are provenance; they never add a secondary graph edge. */
import { recognitionIdentity } from './recognition.js';
import { safeAuthoredHrefSchema, type MentionQueryV2 } from './evidence-v2.js';
export function githubLookup(value:string):{query:MentionQueryV2;source:{provider:'github';id:string;kind:'pull-request'|'issue'};label:string}|null {
 if(!safeAuthoredHrefSchema.safeParse(value).success)return null;
 let u:URL;try{u=new URL(value);}catch{return null;}
 if(u.hostname.toLowerCase()!=='github.com'||u.port||u.username||u.password)return null;
 const p=u.pathname.replace(/\/$/,'').split('/').slice(1);
 if(!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(p[0]??'')||!/^[a-z0-9_.-]{1,100}$/i.test(p[1]??'')||['.','..'].includes(p[1]??'')||!['pull','issues'].includes(p[2]??'')||!/^[1-9]\d*$/.test(p[3]??'')||!Number.isSafeInteger(Number(p[3])))return null;
 const repo=`${p[0]}/${p[1]}`.toLowerCase(),n=String(Number(p[3])),kind=p[2]==='pull'?'pull-request':'issue';
 const source={provider:'github' as const,id:`github.com/${repo}#${n}`,kind:kind as 'pull-request'|'issue'};
 return {source,query:{kind:'resource',target:recognitionIdentity(source),relation:kind==='pull-request'?'github-pr-family':'self'},label:`${repo}#${n}`};
}
