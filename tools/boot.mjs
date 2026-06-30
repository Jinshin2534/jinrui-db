#!/usr/bin/env node
// 本番起動エントリ。
// 事前ビルド済みPGlite(db/data)が同梱されていれば、開かずにそのまま閲覧サーバを起動する
// (PGliteを二重に開くとWASMヒープでメモリが膨らむため、シード判定はファイル存在のみで行う)。
// db/data が無いときだけ同梱.hrflからシードしてから起動する(開発/初回用)。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const prebuilt = !process.env.DATABASE_URL && existsSync(join(HERE, '..', 'db', 'data', 'PG_VERSION'));

if (!prebuilt) {
  const { ensureSeeded } = await import('./db.mjs');
  await ensureSeeded();
}
await import('./serve.mjs');
