// A stand-in for a D1 database in tests: SQLite in memory with TrolaSpy's tables.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async (col) => { const r = db.prepare(sql).get(...args); return r === undefined ? null : col ? r[col] : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { prepare: (sql) => stmt(sql), batch: (list) => Promise.all(list.map((s) => s.run())), sqlite: db };
}
