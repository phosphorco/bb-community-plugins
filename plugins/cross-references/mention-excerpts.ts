/** Source offsets always address the admitted original UTF16 body. */
import { excerptRecordV2Schema, type ExcerptRecordV2, type ExcerptV2 } from '@phosphorco/bb-cross-references';
import type { Span } from '@phosphorco/bb-context-recognition';
const unavailable=(reason:'indivisible-word'|'no-eligible-context'):ExcerptRecordV2=>({state:'unavailable',reason,codecVersion:1});
const lower=(a:readonly number[],v:number)=>{let l=0,r=a.length;while(l<r){const m=(l+r)>>>1;if(a[m]!<v)l=m+1;else r=m;}return l;};
/** Preprocess once per bounded message. Queries do logarithmic boundary seeks,
 * then copy at most320 code points; no body scan per retained occurrence. */
export function createExcerptExtractor(body:string,forbidden:readonly Span[]):(span:Span)=>ExcerptRecordV2 {
 const cp=new Uint32Array(body.length+1),utf8=new Uint32Array(body.length+1);let at=0;
 for(const ch of body){const n=ch.codePointAt(0)!,b=n<=127?1:n<=2047?2:n<=65535?3:4;for(let j=1;j<=ch.length;j++){cp[at+j]=cp[at]!+(j===ch.length?1:0);utf8[at+j]=utf8[at]!+(j===ch.length?b:0);}at+=ch.length;}
 const eligible:Span[]=[];let end=0;for(const hole of forbidden){if(hole.start>end)eligible.push({start:end,end:hole.start});end=Math.max(end,hole.end);}if(end<body.length)eligible.push({start:end,end:body.length});
 const sentences:Span[]=[],cuts:number[]=[],words:Span[]=[];
 const sentenceSegmenter=new Intl.Segmenter('en',{granularity:'sentence'}),wordSegmenter=new Intl.Segmenter('en',{granularity:'word'});
 for(const range of eligible){const source=body.slice(range.start,range.end);for(const s of sentenceSegmenter.segment(source))sentences.push({start:range.start+s.index,end:range.start+s.index+s.segment.length});
  cuts.push(range.start);for(const w of wordSegmenter.segment(source)){const start=range.start+w.index,end=start+w.segment.length;cuts.push(start,end);if(w.isWordLike)words.push({start,end});}cuts.push(range.end);}
 const boundaries=[...new Set(cuts)],sentenceStarts=sentences.map(s=>s.start),wordEnds=words.map(w=>w.end),eligibleStarts=eligible.map(s=>s.start);
 return span=>{
  const safe=eligible[lower(eligibleStarts,span.start+1)-1];
  if(!safe||span.start<safe.start||span.end>safe.end)return unavailable('no-eligible-context');
  const i=lower(sentenceStarts,span.start+1)-1,context=sentences[i];
  if(!context||span.start<context.start||span.start>=context.end)return unavailable('no-eligible-context');
  const word=words[lower(wordEnds,span.start+1)],anchor=word&&word.start<Math.min(context.end,span.end)?word:{start:span.start,end:Math.min(span.end,context.end)};
  const fits=(start:number,end:number)=>cp[end]!-cp[start]!<=320&&utf8[end]!-utf8[start]!<=1280;
  if(!fits(anchor.start,anchor.end))return unavailable('indivisible-word');
  const wholeEnd=boundaries[lower(boundaries,span.end)]??context.end;
  const wholeStart=Math.min(anchor.start,span.start),wholeFits=span.end<=context.end&&wholeEnd<=context.end&&fits(wholeStart,wholeEnd);
  const requiredStart=wholeFits?wholeStart:anchor.start,requiredEnd=wholeFits?wholeEnd:anchor.end;
  let start=anchor.start,finish=anchor.end,best=-1,distance=Infinity;
  // At most320 code points of possible starts can fit before the anchor.
  // Seek endpoints by prefix counts; choose the longest safe word-bound slice,
  // then a stable near-centered tie, without a body scan per occurrence.
  for(let bi=lower(boundaries,Math.max(context.start,requiredStart-640));bi<boundaries.length&&boundaries[bi]!<=requiredStart;bi++){
   let candidateStart=boundaries[bi]!;
   if(!fits(candidateStart,requiredEnd))continue;
   let l=lower(boundaries,requiredEnd),r=lower(boundaries,context.end+1);
   while(l<r){const m=(l+r)>>>1;if(fits(candidateStart,boundaries[m]!))l=m+1;else r=m;}
   let candidateEnd=boundaries[l-1]??anchor.end;
   // Trimming preserves exact original coordinates and complete words.
   while(candidateStart<candidateEnd&&/\s/u.test(body[candidateStart]!))candidateStart++;
   while(candidateEnd>candidateStart&&/\s/u.test(body[candidateEnd-1]!))candidateEnd--;
   const length=cp[candidateEnd]!-cp[candidateStart]!,center=Math.abs(cp[anchor.start]!-cp[candidateStart]!-120);
   if(length>best||(length===best&&center<distance)){start=candidateStart;finish=candidateEnd;best=length;distance=center;}
  }
  if(finish<=span.start||start>=span.end)return unavailable('no-eligible-context');
  return excerptRecordV2Schema.parse({state:'ready',text:body.slice(start,finish),sourceSpan:{start,end:finish},matchSpan:{start:Math.max(0,span.start-start),end:Math.min(finish,span.end)-start},
   clippedBefore:start>context.start||safe.start>0,clippedAfter:finish<context.end||safe.end<body.length,matchClippedBefore:start>span.start,matchClippedAfter:finish<span.end,codecVersion:1});
 };
}
/** Validate persisted evidence without refetching or pretending the body remains
 * available. Original-slice proof is established only at collection/commit. */
export function persistedExcerpt(row:any,revision:string):ExcerptV2 {
 if(row.excerpt_state==null)return {state:'unavailable',reason:'not-materialized',codecVersion:1};
 if(row.excerpt_content_revision!==revision||row.codec_version!==1)throw new Error('Invalid persisted excerpt binding.');
 const bool=(v:unknown)=>{if(v!==0&&v!==1)throw new Error('Invalid persisted clipping flag.');return v===1;};
 const flags={clippedBefore:bool(row.clipped_before),clippedAfter:bool(row.clipped_after),matchClippedBefore:bool(row.match_clipped_before),matchClippedAfter:bool(row.match_clipped_after)};
 if(row.excerpt_state==='unavailable'){
  if(row.excerpt_text!==null||[row.excerpt_source_start,row.excerpt_source_end,row.match_start,row.match_end].some(v=>v!==null)||Object.values(flags).some(Boolean))throw new Error('Invalid persisted unavailable excerpt.');
  return excerptRecordV2Schema.parse({state:'unavailable',reason:row.unavailable_reason,codecVersion:1});
 }
 if(row.unavailable_reason!==null)throw new Error('Invalid persisted ready excerpt reason.');
 const value=excerptRecordV2Schema.parse({state:row.excerpt_state,text:row.excerpt_text,sourceSpan:{start:row.excerpt_source_start,end:row.excerpt_source_end},matchSpan:{start:row.match_start,end:row.match_end},...flags,codecVersion:row.codec_version});
 if(value.state==='ready'){
  if(value.sourceSpan.end>262144||!Number.isSafeInteger(row.span_start)||!Number.isSafeInteger(row.span_end)||row.span_start<0||row.span_end<=row.span_start||row.span_end>262144||
   value.matchSpan.start!==Math.max(0,row.span_start-value.sourceSpan.start)||value.matchSpan.end!==Math.min(row.span_end,value.sourceSpan.end)-value.sourceSpan.start||
   value.matchClippedBefore!==(value.sourceSpan.start>row.span_start)||value.matchClippedAfter!==(value.sourceSpan.end<row.span_end))throw new Error('Invalid persisted excerpt range.');
 }
 return value;
}
