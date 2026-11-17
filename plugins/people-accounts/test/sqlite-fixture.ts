import { Database, type Statement } from 'bun:sqlite';
/** Track fixture-owned statements so restart/cleanup closes the real file, rather than masking a retained connection. */
export function openTestDatabase(path = ':memory:') {
  const db = new Database(path); const statements = new Set<Statement>();
  const prepare = db.prepare.bind(db);
  db.prepare = ((...args: Parameters<typeof prepare>) => { const statement = prepare(...args); statements.add(statement); return statement; }) as typeof db.prepare;
  return { db, close() { for (const statement of statements) statement.finalize(); statements.clear(); db.close(true); } };
}
