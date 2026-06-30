#!/usr/bin/env node
// 人類DB の Postgres レイヤ。PGlite(WASM版Postgres)でローカルに永続化する。
//   db init                  schema.sql を適用(既存を破棄して作り直し)
//   db load <files|dirs...>  .hrf/.hrfl を投入(EDTF→*_num を計算、出典をassertionに展開、関連人物はstub化)
//   db demo                  代表クエリ(タイムライン/範囲検索/関係/来歴)を実行して表示
//   db query "<sql>"         任意SQLを実行
import { openDb } from './dbconn.mjs';
import { edtfBounds } from './edtf.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', 'format', 'schema.sql');
const j = o => (o == null ? null : JSON.stringify(o));
const bnd = e => (e ? edtfBounds(e) : { fromNum: null, toNum: null });

function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) for (const f of readdirSync(p)) { if (f.endsWith('.hrf') || f.endsWith('.hrfl')) out.push(join(p, f)); }
    else out.push(p);
  }
  return out;
}
function readRecords(path) {
  const text = readFileSync(path, 'utf8');
  if (extname(path) === '.hrfl') return text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  return [JSON.parse(text)];
}

async function init() {
  const db = await openDb();
  await db.exec('drop schema if exists public cascade; create schema public;');
  await db.exec(readFileSync(SCHEMA, 'utf8'));
  const { rows } = await db.query(`select count(*)::int n from information_schema.tables where table_schema='public'`);
  console.log(`✓ schema applied — ${rows[0].n} tables (${db.kind})`);
  await db.close();
}

// 本番起動用: DBが空ならスキーマ適用＋同梱シード(format/examples + data/*.hrfl)を投入。冪等。
export async function ensureSeeded() {
  const db = await openDb();
  let count = -1;
  try { count = (await db.query(`select count(*)::int n from person`)).rows[0].n; } catch { count = -1; }
  if (count > 0) { console.log(`DB already seeded: ${count} persons (${db.kind})`); await db.close(); return; }
  console.log(`seeding DB (${db.kind})…`);
  await db.exec('drop schema if exists public cascade; create schema public;');
  await db.exec(readFileSync(SCHEMA, 'utf8'));
  const files = expand([join(HERE, '..', 'format', 'examples'), join(HERE, '..', 'data')]);
  let n = 0;
  await db.transaction(async tx => { for (const f of files) for (const rec of readRecords(f)) { await loadRecord(tx, rec); n++; } });
  const real = (await db.query(`select count(*)::int n from person p where exists(select 1 from name where person_id=p.id)`)).rows[0].n;
  console.log(`seeded ${n} records → ${real} people (${db.kind})`);
  await db.close();
}

async function loadRecord(db, rec) {
  const self = rec.id;
  const q = (s, p) => db.query(s, p);

  // どのソース由来でも id 重複でバッチ全体が落ちないよう、念のため畳む。
  const uniqBy = arr => { const seen = new Set(); return (arr || []).filter(x => x.id == null ? true : (seen.has(x.id) ? false : seen.add(x.id))); };
  const claimsU = uniqBy(rec.claims), eventsU = uniqBy(rec.events), bondsU = uniqBy(rec.bonds);

  const refs = new Set();
  for (const b of bondsU) if (b.with) refs.add(b.with);
  for (const e of eventsU) for (const pt of e.participants || []) if (pt.person) refs.add(pt.person);
  for (const sa of rec.identity?.same_as || []) if (sa.id) refs.add(sa.id);
  refs.delete(self);

  await q(`insert into person(id,status,merged_into,split_from) values($1,$2,$3,$4)
           on conflict(id) do update set status=excluded.status, updated_at=now()`,
    [self, rec.status || 'unknown', rec.identity?.merged_into || null, rec.identity?.split_from || null]);
  for (const id of refs) await q(`insert into person(id,status) values($1,'unknown') on conflict(id) do nothing`, [id]);

  // 冪等な再投入: このpersonの子レコードを一掃してから入れ直す
  await q(`delete from assertion where subject_id like $1`, [self + '::%']);
  await q(`delete from source where id like $1`, [self + '::%']);
  for (const t of ['bond', 'event', 'claim', 'name', 'person_identifier', 'consent', 'stewardship'])
    await q(`delete from ${t} where person_id=$1`, [self]);

  for (const x of rec.identity?.external_ids || [])
    await q(`insert into person_identifier(person_id,scheme,value) values($1,$2,$3) on conflict do nothing`, [self, x.scheme, String(x.value)]);
  for (const sa of rec.identity?.same_as || [])
    if (sa.id) await q(`insert into identity_link(person_id,other_id,kind,confidence,asserted_by,note) values($1,$2,'same_as',$3,$4,$5)`,
      [self, sa.id, sa.confidence ?? null, sa.by ?? null, sa.note ?? null]);

  const srcMap = new Map();
  for (const s of rec.sources || []) {
    const dbId = `${self}::${s.id}`; srcMap.set(s.id, { dbId, kind: s.kind });
    await q(`insert into source(id,kind,ref,retrieved,reliability,license,signature) values($1,$2,$3,$4,$5,$6,$7)`,
      [dbId, s.kind || null, s.ref ?? null, s.retrieved ?? null, s.reliability ?? null, s.license ?? null, s.signature ?? null]);
  }
  const method = k => (k === 'wikidata' ? 'wikidata-import' : k === 'self' ? 'self' : 'manual');
  const assert = async (kind, id, src, conf) => {
    for (const sid of src || []) { const m = srcMap.get(sid); if (!m) continue;
      await q(`insert into assertion(subject_kind,subject_id,source_id,method,confidence) values($1,$2,$3,$4,$5)`, [kind, id, m.dbId, method(m.kind), conf ?? null]); }
  };

  let i = 0;
  for (const n of rec.names || []) {
    const id = `${self}::name::${i++}`, b = bnd(n.valid?.edtf);
    await q(`insert into name(id,person_id,type,full_name,parts,script,lang,valid_edtf,valid_from_num,valid_to_num,epistemic,confidence)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, self, n.type ?? null, n.full, j(n.parts), n.script ?? null, n.lang ?? null, n.valid?.edtf ?? null, b.fromNum, b.toNum, n.epistemic ?? null, n.confidence ?? null]);
    await assert('name', id, n.src, n.confidence);
  }
  i = 0;
  for (const c of claimsU) {
    const id = `${self}::${c.id || 'claim' + i}`; i++; const b = bnd(c.valid?.edtf);
    await q(`insert into claim(id,person_id,prop,value,qualifiers,valid_edtf,valid_from_num,valid_to_num,epistemic,confidence,asserted_by,asserted_at,retracted_at)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, self, c.prop, j(c.value), j(c.qualifiers), c.valid?.edtf ?? null, b.fromNum, b.toNum, c.epistemic ?? null, c.confidence ?? null, c.asserted?.by ?? null, c.asserted?.at ?? null, c.asserted?.retracted ?? null]);
    await assert('claim', id, c.src, c.confidence);
  }
  i = 0;
  for (const e of eventsU) {
    const id = `${self}::${e.id || 'event' + i}`; i++; const b = bnd(e.when?.edtf), g = e.where?.geo;
    await q(`insert into event(id,person_id,type,label,when_edtf,when_from_num,when_to_num,place_label,place_ref,geo_lat,geo_lon,payload,epistemic,confidence)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, self, e.type, e.label ?? null, e.when?.edtf ?? null, b.fromNum, b.toNum, e.where?.label ?? null, j(e.where?.ref), g?.[0] ?? null, g?.[1] ?? null, j(e.payload), e.epistemic ?? null, e.confidence ?? null]);
    for (const pt of e.participants || []) if (pt.person) await q(`insert into event_participant(event_id,person_id,role) values($1,$2,$3) on conflict do nothing`, [id, pt.person, pt.role]);
    await assert('event', id, e.src, e.confidence);
  }
  i = 0;
  for (const bd of bondsU) {
    const id = `${self}::${bd.id || 'bond' + i}`; i++; const b = bnd(bd.valid?.edtf);
    await q(`insert into bond(id,person_id,rel,with_id,valid_edtf,valid_from_num,valid_to_num,via_event,epistemic,confidence)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, self, bd.rel, bd.with, bd.valid?.edtf ?? null, b.fromNum, b.toNum, bd.via_event ? `${self}::${bd.via_event}` : null, bd.epistemic ?? null, bd.confidence ?? null]);
    await assert('bond', id, bd.src, bd.confidence);
  }
  if (rec.stewardship?.account) {
    await q(`insert into account(id) values($1) on conflict(id) do nothing`, [rec.stewardship.account]);
    await q(`insert into stewardship(account_id,person_id,claimed_at,verification) values($1,$2,$3,$4) on conflict do nothing`,
      [rec.stewardship.account, self, rec.stewardship.claimed_at ?? null, rec.stewardship.verification ?? null]);
  }
  if (rec.consent)
    await q(`insert into consent(person_id,scope,fields,rtbf,license,signed_by,signature) values($1,$2,$3,$4,$5,$6,$7)`,
      [self, rec.consent.scope ?? null, j(rec.consent.fields), rec.consent.rtbf ?? false, rec.consent.license ?? null, rec.consent.signed_by ?? null, rec.consent.signature ?? null]);
}

async function load(paths) {
  const db = await openDb();
  const files = expand(paths);
  let n = 0;
  try {
    await db.transaction(async tx => {
      for (const f of files) for (const rec of readRecords(f)) { await loadRecord(tx, rec); n++; }
    });
  } catch (e) { console.error('✗ load failed, rolled back:', e.message); await db.close(); process.exit(1); }
  const c = async t => (await db.query(`select count(*)::int n from ${t}`)).rows[0].n;
  console.log(`✓ loaded ${n} record(s) from ${files.length} file(s) (${db.kind})`);
  console.log(`  person=${await c('person')} (stub含む)  name=${await c('name')}  claim=${await c('claim')}  event=${await c('event')}  bond=${await c('bond')}  source=${await c('source')}  assertion=${await c('assertion')}`);
  await db.close();
}

async function demo() {
  const db = await openDb();
  const show = (title, rows) => { console.log(`\n── ${title} ──`); console.table(rows); };

  // 1. 人物の概観(本人のみ=スタブ除外)
  show('取り込み済みの人物(claimを持つ=実体)', (await db.query(
    `select p.id, (select full_name from name where person_id=p.id order by case type when 'legal' then 0 else 1 end limit 1) as name,
            p.status, (select count(*)::int from claim where person_id=p.id) as claims, (select count(*)::int from event where person_id=p.id) as events
     from person p where exists(select 1 from name n where n.person_id=p.id) order by name`)).rows);

  // 2. マリ・キュリーの一生(イベントを時間順=*_numで)
  show('マリ・キュリーのタイムライン(when_from_numで時系列ソート)', (await db.query(
    `select type, when_edtf, coalesce(label, place_label) as detail from event
     where person_id='hrf:person:wd-Q7186' order by when_from_num nulls last limit 8`)).rows);

  // 3. 範囲検索: 1900年より前に生まれた人(EDTF→通日はアプリで計算して渡す)
  const before1900 = edtfBounds('1900').fromNum;
  show(`範囲検索: 出生 < 1900(通日<${before1900})`, (await db.query(
    `select n.full_name as name, e.when_edtf as born from event e
     join name n on n.person_id=e.person_id and n.type in ('legal','birth')
     where e.type='birth' and e.when_from_num < $1 order by e.when_from_num`, [before1900])).rows);

  // 4. 関係グラフ: spouse_of を名前で解決
  show('関係(spouse_of を名前解決)', (await db.query(
    `select a.full_name as person, b.rel, c.full_name as related, b.valid_edtf as period
     from bond b join name a on a.person_id=b.person_id and a.type in ('legal','birth')
     left join name c on c.person_id=b.with_id and c.type in ('legal','birth')
     where b.rel='spouse_of' order by person limit 6`)).rows);

  // 5. 来歴(provenance)結合: ある国籍claimの出典を辿る
  show('来歴: claim → assertion → source', (await db.query(
    `select c.prop, c.value->>'entity' as value, s.kind as source_kind, s.ref as source_ref, a.method
     from claim c join assertion a on a.subject_kind='claim' and a.subject_id=c.id
     join source s on s.id=a.source_id
     where c.prop='citizenship' limit 5`)).rows);

  // 6. 自己統治: 生者の項目別公開範囲
  show('生者の同意範囲(consent.fields)', (await db.query(
    `select p.id, c.scope, c.fields from consent c join person p on p.id=c.person_id`)).rows);

  await db.close();
}

async function query(sql) {
  const db = await openDb();
  const r = await db.query(sql);
  console.table(r.rows);
  await db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...rest] = process.argv;
  const run = {
    init: () => init(),
    load: () => rest.length ? load(rest) : (console.error('usage: db load <files|dirs...>'), process.exit(2)),
    demo: () => demo(),
    query: () => rest.length ? query(rest.join(' ')) : (console.error('usage: db query "<sql>"'), process.exit(2)),
  }[cmd];
  if (!run) { console.error('commands: init | load <files> | demo | query "<sql>"'); process.exit(cmd ? 2 : 0); }
  run().catch(e => { console.error(e); process.exit(1); });
}
