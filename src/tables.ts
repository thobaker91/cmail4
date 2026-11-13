// Cmail — shared table registry.
// The embedded schema (src/generated/schema.ts) parsed once into per-table
// groups, plus the exact column list each table should have. Both the Setup
// wizard and the Health panel read from here, so "build what's missing" and
// "repair what's old" always agree with what the code actually queries.
import { SCHEMA } from './generated/schema';

export type TableDef = {
  name: string;
  stmts: typeof SCHEMA;
  columns: string[]; // expected columns, parsed from the CREATE TABLE body
};

// split a CREATE TABLE body on top-level commas (paren-depth aware) and
// return the first word of every real column definition
function parseColumns(createSql: string): string[] {
  const m = /\(([\s\S]*)\)\s*$/.exec(createSql.replace(/\s+$/, ''));
  if (!m) return [];
  const body = m[1];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim().split(/\s+/)[0]?.replace(/["'`]/g, '') ?? '')
    .filter((c) => c && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(c));
}

export const TABLES: TableDef[] = (() => {
  const map = new Map<string, TableDef>();
  for (const stmt of SCHEMA) {
    const m = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt.sql)
      ?? /CREATE INDEX IF NOT EXISTS \w+ ON (\w+)/.exec(stmt.sql)
      ?? /ALTER TABLE (\w+)/.exec(stmt.sql);
    if (!m) continue;
    let def = map.get(m[1]);
    if (!def) { def = { name: m[1], stmts: [], columns: [] }; map.set(m[1], def); }
    def.stmts.push(stmt);
  }
  for (const def of map.values()) {
    const create = def.stmts.find((s) => /CREATE TABLE IF NOT EXISTS/.test(s.sql));
    if (create) def.columns = parseColumns(create.sql);
  }
  return [...map.values()];
})();

export const EXPECTED = new Set(TABLES.map((t) => t.name));
