#!/usr/bin/env node
// 本番起動エントリ。DBが空ならスキーマ適用＋同梱シードを投入し、続けて閲覧サーバを起動する。
// Render 等の Start Command に `node boot.mjs` を指定する(外部DB不要・PGliteを同梱.hrflから再構築)。
import { ensureSeeded } from './db.mjs';
await ensureSeeded();
await import('./serve.mjs');
