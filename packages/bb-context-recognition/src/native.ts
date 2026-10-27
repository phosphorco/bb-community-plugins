import { LinkifyInputV1Schema, SourceIdentitySchema, SafeHrefSchema, LIMITS, type LinkifyInputV1, type TaggedCandidateV1 } from './index.js';
type Reference = {source: import('./index.js').SourceIdentity; recruitment:{kind:'mention';text:string;span:{start:number;end:number}}};
type RecognizedReference = {reference:Reference;start:number;end:number};
const generatedId = 'thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}';
const word = /[\p{L}\p{N}_.+\/-]/u;
function escaped(text: string, start: number) { let count = 0; for (let i = start - 1; text[i] === '\\'; --i) ++count; return count % 2 === 1; }
function bounded(text: string, start: number, end: number) {
  const previous = text[start - 1]; const next = text[end];
  return !(previous && word.test(previous)) && !(next === '.' ? /[^\s,;:!?)}\]"'’”]/u.test(text[end + 1] ?? '') : next && word.test(next));
}
/** Cheap candidates only. Eligibility is owned by the one Markdown AST pass;
 * files become links only after the resolver verifies existence/containment. */
function recognizeReferenceText(text: string, offset = 0, bbOrigin?: string): RecognizedReference[] {
  const found: (RecognizedReference & { priority: number })[] = [];
  const add = (start: number, end: number, source: Reference['source'], priority: number) => {
    if (end <= start || end - start > 4096 || escaped(text, start) || !bounded(text, start, end)) return;
    const reference: Reference = { source, recruitment: { kind: 'mention', text: text.slice(start, end), span: { start: offset + start, end: offset + end } } };
    // Reject only the candidate: oversized contributor/file IDs must stay readable.
    if (!SourceIdentitySchema.safeParse(source).success) return;
    found.push({ start, end, priority, reference });
  };
  const urls = new RegExp(`(?:https?:\\/\\/[^\\s<>"'()]+)?\\/projects\\/[^\\s/<>"'()]+\\/threads\\/(${generatedId})(?:[?#][^\\s<>"'()]*)?`, 'gu');
  for (const match of text.matchAll(urls)) {
    const token = match[0].replace(/[.,;:!?]+$/u, '');
    try { const url = new URL(token, bbOrigin ?? 'https://bb.invalid'); if (token.startsWith('http') && (!bbOrigin || url.origin !== new URL(bbOrigin).origin)) continue;
      add(match.index, match.index + token.length, { provider: 'bb.thread', kind: 'session', id: match[1]! }, 0);
    } catch { /* Not a BB URL. */ }
  }
  for (const match of text.matchAll(new RegExp(`(?:@thread:)?(${generatedId})`, 'gu'))) add(match.index, match.index + match[0].length, { provider: 'bb.thread', kind: 'session', id: match[1]! }, 1);
  for (const match of text.matchAll(/(?:\.\/)?[\p{L}\p{N}_][\p{L}\p{N}_./-]*/gu)) {
    const token = match[0].replace(/[.,;:!?]+$/u, ''); const path = token.replace(/^\.\//u, '');
    if(!/\.[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(path))continue;
    if(/(?:workspace|thread-storage):$/u.test(text.slice(0,match.index)))continue;
    if (path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('..') || /^(?:workspace|thread-storage):/u.test(path)) continue;
    add(match.index, match.index + token.length, { provider: 'bb.file', kind: 'file', id: path }, 2);
  }
  return found;
}

export function nativeCandidates(input:LinkifyInputV1, origin?:string, provider?:string) {
 input=LinkifyInputV1Schema.parse(input);
 const found=recognizeReferenceText(input.text,0,origin).map(r=>({span:r.reference.recruitment.span,match:r.reference.recruitment.text,source:r.reference.source,confidence:'high' as const,provenance:{basis:'explicit' as const,explanation:'Native BB reference.'}}));
 for(const m of input.text.matchAll(/https?:\/\/[^\s<>"'()]+/gu)){const match=m[0].replace(/[.,;:!?]+$/u,'');if(SafeHrefSchema.safeParse(match).success && SourceIdentitySchema.safeParse({provider:'bb.url',id:match}).success)found.push({span:{start:m.index,end:m.index+match.length},match,source:{provider:'bb.url',id:match,kind:'url'},confidence:'high',provenance:{basis:'explicit',explanation:'Explicit URL.'}});}
 for(const c of found)if(c.source.provider==='bb.file')c.source={...c.source,id:`${input.context.threadId??''}:${c.source.id}`};
 return found.filter(c=>SourceIdentitySchema.safeParse(c.source).success && (c.source.provider!=='bb.file' || !!input.context.threadId) && (!provider || c.source.provider===provider) && !input.excluded.some(s=>s.start<c.span.end && c.span.start<s.end)).sort((a,b)=>a.span.start-b.span.start||b.span.end-a.span.end).filter((c,i,a)=>!i || c.source.provider!==a[i-1]!.source.provider || c.span.start!==a[i-1]!.span.start || c.span.end!==a[i-1]!.span.end).slice(0,LIMITS.candidatesPerCall);
}
