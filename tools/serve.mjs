#!/usr/bin/env node
// 人類DB 閲覧Web のサーバ。PGlite(DB)を持ち、JSON API と静的フロントを配信する。
//   node serve.mjs            → http://localhost:5320
// 依存は @electric-sql/pglite のみ。生者の consent(項目別公開範囲)を適用して非公開項目は配信しない。
import { openDb } from './dbconn.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const PORT = Number(process.env.PORT) || 5320;

const db = await openDb();
const q = (sql, params) => db.query(sql, params).then(r => r.rows);
const asObj = v => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const inParams = (arr, start = 1) => arr.map((_, i) => `$${start + i}`).join(',');
const NAME_ORDER = `order by case type when 'legal' then 0 when 'birth' then 1 else 2 end limit 1`;

// 生者の非公開プロパティ集合(public 以外)。誕生日は birth_date キーで制御。
function hiddenProps(consent) {
  const f = asObj(consent?.fields) || {};
  return new Set(Object.entries(f).filter(([, v]) => v && v !== 'public').map(([k]) => k));
}

async function people() {
  return q(`select p.id, p.status,
      (select full_name from name where person_id=p.id ${NAME_ORDER}) as name,
      (select when_edtf from event where person_id=p.id and type='birth' limit 1) as birth,
      (select when_edtf from event where person_id=p.id and type='death' limit 1) as death,
      (select count(*)::int from claim where person_id=p.id) as claims,
      (select count(*)::int from event where person_id=p.id) as events,
      (select count(*)::int from bond  where person_id=p.id) as bonds
    from person p
    where exists(select 1 from name n where n.person_id=p.id)
    order by birth nulls last, name`);
}

async function person(id) {
  const prow = (await q(`select id, status, merged_into from person where id=$1`, [id]))[0];
  if (!prow) return null;
  const consent = (await q(`select scope, fields from consent where person_id=$1`, [id]))[0] || null;
  const hidden = hiddenProps(consent);

  const srcRows = await q(`select a.subject_id, s.kind, s.ref, s.reliability, a.method, s.signature
    from assertion a join source s on s.id=a.source_id where a.subject_id like $1`, [id + '::%']);
  const srcOf = new Map();
  for (const r of srcRows) { (srcOf.get(r.subject_id) || srcOf.set(r.subject_id, []).get(r.subject_id)).push(r); }
  const withSrc = row => ({ ...row, sources: srcOf.get(row.id) || [] });

  const names = (await q(`select id, type, full_name as full, script, lang, valid_edtf, epistemic, confidence
    from name where person_id=$1 order by case type when 'legal' then 0 when 'birth' then 1 else 2 end, full_name`, [id])).map(withSrc);

  const external_ids = await q(`select scheme, value from person_identifier where person_id=$1 order by scheme`, [id]);

  let claims = (await q(`select id, prop, value, qualifiers, valid_edtf, epistemic, confidence
    from claim where person_id=$1 order by prop`, [id]))
    .filter(c => !hidden.has(c.prop))
    .map(c => withSrc({ ...c, value: asObj(c.value), qualifiers: asObj(c.qualifiers) }));

  let events = (await q(`select id, type, label, when_edtf, place_label, place_ref, geo_lat, geo_lon, epistemic, confidence
    from event where person_id=$1 order by when_from_num nulls last, type`, [id]))
    .filter(e => !(e.type === 'birth' && hidden.has('birth_date')))
    .map(e => withSrc({ ...e, place_ref: asObj(e.place_ref) }));

  const bonds = (await q(`select b.id, b.rel, b.with_id, b.valid_edtf, b.via_event, b.epistemic, b.confidence,
      (select full_name from name where person_id=b.with_id ${NAME_ORDER}) as with_name,
      exists(select 1 from name where person_id=b.with_id) as with_real
    from bond b where b.person_id=$1 order by b.rel`, [id])).map(withSrc);

  const hiddenList = [...hidden];
  return { id: prow.id, status: prow.status, merged_into: prow.merged_into, consent, hidden: hiddenList, names, external_ids, claims, events, bonds };
}

// 関係グラフ(ego networks)。家族の対称/逆向き辺を正規化して重複を畳む。
async function graph(id) {
  const touching = await q(`select person_id as src, with_id as dst, rel, valid_edtf as period
    from bond where person_id=$1 or with_id=$1`, [id]);
  const ids = [...new Set([id, ...touching.flatMap(e => [e.src, e.dst])])];
  const edgesRaw = await q(`select person_id as src, with_id as dst, rel, valid_edtf as period
    from bond where person_id in (${inParams(ids)}) and with_id in (${inParams(ids, ids.length + 1)})`, [...ids, ...ids]);
  const nodes = await q(`select p.id, p.status,
      (select full_name from name where person_id=p.id ${NAME_ORDER}) as name,
      exists(select 1 from name where person_id=p.id) as real
    from person p where p.id in (${inParams(ids)})`, ids);

  const seen = new Map();
  for (let { src, dst, rel, period } of edgesRaw) {
    let kind = rel, a = src, b = dst;
    if (rel === 'child_of') { kind = 'parent_of'; a = dst; b = src; }       // 親→子に統一
    if (rel === 'student_of') { kind = 'mentor_of'; a = dst; b = src; }     // 師→弟子に統一
    const undirected = kind === 'spouse_of' || kind === 'sibling_of';
    const key = undirected ? `${kind}|${[a, b].sort().join('|')}` : `${kind}|${a}|${b}`;
    if (!seen.has(key)) seen.set(key, { src: a, dst: b, rel: kind, period, undirected });
  }
  return { ego: id, nodes, edges: [...seen.values()] };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (p === '/api/people') return json(res, await people());
    if (p === '/api/person') { const d = await person(url.searchParams.get('id')); return d ? json(res, d) : json(res, { error: 'not found' }, 404); }
    if (p === '/api/graph') return json(res, await graph(url.searchParams.get('id')));

    // 静的配信(web/ 配下、ディレクトリトラバーサル防止)
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(file).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { json(res, { error: e.message }, 500); }
}).listen(PORT, () => console.log(`人類DB viewer (${db.kind}) → http://localhost:${PORT}`));
