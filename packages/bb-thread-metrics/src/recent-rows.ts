import {z} from 'zod';
import {RECENT_LIMITS,recentSnapshotInputSchema,recentSnapshotFullSchema,validateRecentSnapshot} from './recent.js';
import type {RecentSnapshot,RecentSnapshotInput,RecentSnapshotResult} from './recent.js';

/** Additive method: v1 full/unchanged remain identical; only this negotiated
 * endpoint may omit rows while carrying a new full-publication header. */
export const RECENT_ROWS_METHOD='threadMetricsRecentRowsV1';
export const recentRowsInputSchema=recentSnapshotInputSchema;
const reuseSchema=recentSnapshotFullSchema.omit({rows:true}).extend({rowsUnchanged:z.literal(true),baseRevision:z.string().min(1).max(256)}).strip();
export type RecentRowsReuse=z.infer<typeof reuseSchema>;
export type RecentRowsResult=RecentSnapshotResult|RecentRowsReuse;
export class RecentRowsBaselineMissing extends Error {constructor(){super('Recent rows baseline missing or mismatched');}}
export class RecentRowsUnsupportedVersion extends Error {constructor(){super('Unsupported recent rows wire version');}}

/** Supplier must establish exact row equality with the requested baseline.
 * No source reads, hashing, retained history or publication mutation here. */
export function projectRecentRows(input:RecentSnapshotInput,snapshot:RecentSnapshot,reuseRows:boolean):RecentRowsResult {
 recentRowsInputSchema.parse(input);
 if(input.ifRevision===snapshot.revision)return {version:1,unchanged:true,revision:snapshot.revision};
 if(!input.ifRevision||!reuseRows)return snapshot;
 const {rows:_,...metadata}=snapshot;
 return {...metadata,rowsUnchanged:true,baseRevision:input.ifRevision};
}

/** Owner-side header admission cannot prove client baseline possession. */
export function validateRecentRowsHeader(input:RecentSnapshotInput,raw:unknown):RecentRowsReuse {
 recentRowsInputSchema.parse(input);
 const json=JSON.stringify(raw);
 if(json===undefined||new TextEncoder().encode(json).byteLength>RECENT_LIMITS.bytes)throw new Error('Snapshot byte limit');
 if(!raw||typeof raw!=='object'||Object.hasOwn(raw,'rows'))throw new Error('Invalid recent rows header');
 let count=0;for(const rows of [(raw as {heatInputs?:{rows?:unknown}}).heatInputs?.rows,(raw as {availability?:{rows?:unknown}}).availability?.rows])if(rows!==undefined){if(!Array.isArray(rows)||(count+=rows.length)>RECENT_LIMITS.rows)throw new Error('Snapshot aggregate row limit');for(const row of rows)if(new TextEncoder().encode(JSON.stringify(row)).byteLength>RECENT_LIMITS.rowBytes)throw new Error('Snapshot row byte limit');}
 const value=reuseSchema.parse(raw);
 if(!input.ifRevision||value.baseRevision!==input.ifRevision)throw new RecentRowsBaselineMissing();
 return value;
}

/** Reconstruct only against the exact admitted source/session baseline. All
 * fresh metadata is validated together with the retained rows, so a changed
 * config/rank/activity/coverage context cannot silently reuse invalid data. */
export function validateRecentRows(input:RecentSnapshotInput,raw:unknown,baseline?:RecentSnapshot):RecentSnapshotResult {
 recentRowsInputSchema.parse(input);
 const json=JSON.stringify(raw);
 if(json===undefined||new TextEncoder().encode(json).byteLength>RECENT_LIMITS.bytes)throw new Error('Snapshot byte limit');
 if(raw&&typeof raw==='object'&&'version' in raw&&raw.version!==1)throw new RecentRowsUnsupportedVersion();
 if(!raw||typeof raw!=='object'||!('rowsUnchanged' in raw))return validateRecentSnapshot(input,raw);
 if(raw.rowsUnchanged!==true||Object.hasOwn(raw,'rows'))throw new Error('Invalid recent rows reuse payload');
 const decoded=validateRecentRowsHeader(input,raw);
 if(!baseline||!input.ifRevision||baseline.revision!==input.ifRevision||decoded.baseRevision!==input.ifRevision)throw new RecentRowsBaselineMissing();
 const {rowsUnchanged:_,baseRevision:__,...metadata}=decoded;
 const full=validateRecentSnapshot({}, {...metadata,rows:baseline.rows});
 if(full.unchanged)throw new Error('Row reuse requires fresh full metadata');
 // The trusted baseline is immutable. Validation above checks the combined
 // context; keep its exact row array rather than retaining a second copy.
 return {...full,rows:baseline.rows};
}
