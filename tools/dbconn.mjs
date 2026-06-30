// DB接続の抽象化。ローカルは PGlite、本番は DATABASE_URL のマネージドPostgres(Neon/Supabase等)。
// どちらも同じ {query, exec, transaction, close} を返すので db.mjs / serve.mjs は無改造で両対応。
// PGlite / pg はどちらも動的importで、使う方だけを読み込む(本番イメージはPGlite未ロード)。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'db', 'data');

export const dbKind = () => (process.env.DATABASE_URL ? 'postgres' : 'pglite');

export async function openDb() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { default: pg } = await import('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX) || 8, ssl });
    return {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),                  // 複数文(パラメータ無し)を simple protocol で実行
      // pool では文ごとに別コネクションになりうるので、トランザクションは専用クライアントで張る
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const r = await fn({ query: (s, p) => client.query(s, p) });
          await client.query('commit');
          return r;
        } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  mkdirSync(DATA, { recursive: true });
  const db = await PGlite.create(DATA);
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: async (fn) => {
      await db.exec('begin');
      try { const r = await fn({ query: (s, p) => db.query(s, p) }); await db.exec('commit'); return r; }
      catch (e) { await db.exec('rollback').catch(() => {}); throw e; }
    },
    close: () => db.close(),
  };
}
