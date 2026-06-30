#!/usr/bin/env node
// ローカルPGlite(db/data)→ DATABASE_URL のPostgres へ全行をバルク転送する。
// 1行ずつの投入は高遅延ネットワークで遅すぎるため、テーブル単位のチャンクINSERTで一気に送る。
//   DATABASE_URL='postgres://…' node tools/seed-remote.mjs
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'db', 'data');
const SCHEMA = join(HERE, '..', 'format', 'schema.sql');
const url = process.env.DATABASE_URL;
if (!url) { console.error('set DATABASE_URL'); process.exit(2); }

// FK安全な順序(親→子)
const TABLES = ['person', 'source', 'name', 'claim', 'event', 'event_participant',
  'bond', 'assertion', 'person_identifier', 'identity_link', 'account', 'stewardship', 'consent'];

const src = await PGlite.create(DATA);
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });

console.error('applying schema → postgres…');
await pool.query('drop schema if exists public cascade; create schema public;');
await pool.query(readFileSync(SCHEMA, 'utf8'));

const client = await pool.connect();
await client.query('begin');
let total = 0;
for (const t of TABLES) {
  const res = await src.query(`select * from ${t}`);
  const rows = res.rows;
  if (!rows.length) { console.error(`  ${t}: 0`); continue; }
  const cols = res.fields ? res.fields.map(f => f.name) : Object.keys(rows[0]);
  const colList = cols.map(c => `"${c}"`).join(',');
  const perChunk = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params = [];
    const tuples = chunk.map(r => '(' + cols.map(c => {
      let v = r[c];
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) v = JSON.stringify(v); // jsonb
      params.push(v);
      return '$' + params.length;
    }).join(',') + ')');
    await client.query(`insert into ${t} (${colList}) values ${tuples.join(',')}`, params);
  }
  total += rows.length;
  console.error(`  ${t}: ${rows.length}`);
}
await client.query('commit');
client.release();
await pool.end();
await src.close();
console.error(`✓ transferred ${total} rows → postgres`);
