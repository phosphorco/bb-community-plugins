import type Database from 'better-sqlite3';
import type { TaggedCandidateV1 } from '@phosphorco/bb-context-recognition';
import type { ConversationMessage } from './mention-collection.ts';

export type CollectionCheckpoint = {
  maxSeq: number | null; contextBoundarySeq?:number|null; headIds?:string[]; cursor: {anchorSeq:number;anchorId:string} | null;
  pages: number; ready: boolean; complete: boolean; sourceLimited: boolean;
  missingMessageSeq: boolean; textChars: number; title: string; environmentId?: string; pureKey?: string; pureReceipt?:{graph:number;evidence:string};
};

/** Disposable source material, never authority for native targets. SQLite owns
 * the cursor and accepted messages together; graph/evidence commit separately.
 * Eviction only costs a rescan. No generation, job or retry is evicted. */
export class CollectionCheckpoints {
  private readonly db: Database.Database;
  constructor(db: Database.Database) { this.db=db; }
  load(threadId:string):CollectionCheckpoint|undefined {
    const row=this.db.prepare('SELECT state_json FROM assistant_link_checkpoints WHERE thread_id=?').get(threadId) as {state_json:string}|undefined;
    return row ? JSON.parse(row.state_json) : undefined;
  }
  messageIds(threadId:string):string[] {
    return (this.db.prepare('SELECT message_id FROM assistant_link_checkpoint_messages WHERE thread_id=?').all(threadId) as {message_id:string}[]).map(row=>row.message_id);
  }
  messages(threadId:string):ConversationMessage[] {
    return (this.db.prepare('SELECT message_json FROM assistant_link_checkpoint_messages WHERE thread_id=? ORDER BY rowid').all(threadId) as {message_json:string}[]).map(row=>JSON.parse(row.message_json));
  }
  receipt(projectId:string,threadId:string):{graph:number;evidence:string}|undefined {
    return this.db.prepare(`SELECT p.revision AS graph,s.evidence_digest AS evidence FROM source_projections p
      JOIN resources r ON r.id=p.source_resource_id JOIN mention_streams s ON s.source_resource_id=r.id AND s.producer_plugin_id=p.producer_plugin_id
      WHERE p.producer_plugin_id='cross-references' AND r.provider='bb' AND r.canonical_keys_json=? AND p.tombstone=0`)
      .get(JSON.stringify({project:projectId,thread:threadId})) as {graph:number;evidence:string}|undefined;
  }
  remove(threadId:string):void { this.db.prepare('DELETE FROM assistant_link_checkpoints WHERE thread_id=?').run(threadId); }
  save(threadId:string,state:CollectionCheckpoint,messages:readonly ConversationMessage[]):void {
    this.db.transaction(()=>{
      this.db.prepare(`INSERT INTO assistant_link_checkpoints VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state_json=excluded.state_json,touched_at=excluded.touched_at`).run(threadId,JSON.stringify(state),Date.now());
      const insert=this.db.prepare('INSERT OR IGNORE INTO assistant_link_checkpoint_messages VALUES (?, ?, ?)');
      for(const message of messages)insert.run(threadId,message.id,JSON.stringify(message));
      this.db.prepare(`DELETE FROM assistant_link_checkpoints WHERE thread_id IN
        (SELECT thread_id FROM assistant_link_checkpoints WHERE thread_id != ? ORDER BY touched_at DESC,rowid DESC LIMIT -1 OFFSET 31)`).run(threadId);
    })();
  }
}

/** Keep the existing 64-entry hot cache and a bounded durable backing for pure
 * supplier results. Native verification is deliberately never cached here.
 * A detached obsolete attempt cannot read or populate a newer supplier epoch. */
export class RecognitionCheckpointCache extends Map<string,TaggedCandidateV1[]> {
  private readonly db:Database.Database;
  private readonly current:()=>boolean;
  constructor(db:Database.Database,current:()=>boolean) {super();this.db=db;this.current=current;}
  override get(key:string):TaggedCandidateV1[]|undefined {
    if(!this.current())return undefined;
    const hot=super.get(key);if(hot)return hot;
    const row=this.db.prepare('SELECT candidates_json FROM assistant_link_recognition_cache WHERE cache_key=?').get(key) as {candidates_json:string}|undefined;
    if(!row)return undefined;
    this.db.prepare('UPDATE assistant_link_recognition_cache SET touched_at=? WHERE cache_key=?').run(Date.now(),key);
    return JSON.parse(row.candidates_json);
  }
  override set(key:string,value:TaggedCandidateV1[]):this {
    if(!this.current())return this;
    const json=JSON.stringify(value),bytes=Buffer.byteLength(json);
    if(bytes>65_536)return this;
    this.db.transaction(()=>{
      this.db.prepare(`INSERT INTO assistant_link_recognition_cache VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET candidates_json=excluded.candidates_json,bytes=excluded.bytes,touched_at=excluded.touched_at`).run(key,json,bytes,Date.now());
      // Both entry and byte limits: 512 tiny results or at most 16 MiB.
      const rows=this.db.prepare('SELECT cache_key, bytes FROM assistant_link_recognition_cache ORDER BY touched_at DESC,rowid DESC').all() as {cache_key:string;bytes:number}[];
      let total=0;
      const remove=this.db.prepare('DELETE FROM assistant_link_recognition_cache WHERE cache_key=?');
      rows.forEach((row,index)=>{total+=row.bytes;if(index>=512 || total>16*1024*1024)remove.run(row.cache_key);});
    })();
    return super.set(key,value);
  }
}
