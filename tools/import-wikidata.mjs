#!/usr/bin/env node
// Wikidata → HRF インポータ。
//   import-wikidata <QID...>                      取得→HRFをstdoutへ
//   import-wikidata --out <dir> <QID...>          <dir>/wd-<QID>.hrf を書き出し
//   import-wikidata --hrfl <file> <QID...>        <file> に1行1レコードで追記(.hrfl)
//   import-wikidata --file <json> <QID>           Special:EntityData JSON をローカル読み(オフライン)
//   import-wikidata --preset <name> --hrfl <f>    SPARQLで一括選定して量産(--limit/--concurrency)
//   import-wikidata --sparql-file <q> --hrfl <f>  任意SPARQL(?person のQID列)で一括選定
//   import-wikidata selftest                      ネット不要の変換テスト
import { entityToHRF, collectReferencedQids, wikidataTimeToEDTF, hrfId } from './wikidata.mjs';
import { validateRecord } from './hrf.mjs';
import { writeFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const UA = 'jinrui-db-hrf-importer/0.1 (https://github.com/Jinshin2534/jinrui-db; human-database research)';
const today = () => new Date().toISOString().slice(0, 10);

async function fetchEntity(qid) {
  const r = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${qid}`);
  const j = await r.json();
  const e = j.entities?.[qid];
  if (!e) throw new Error(`no entity ${qid} in response`);
  return e;
}

async function fetchLabels(qids) {
  const out = {};
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}&props=labels&languages=en|ja&format=json`, { headers: { 'User-Agent': UA } });
    if (!r.ok) continue;
    const j = await r.json();
    for (const [qid, e] of Object.entries(j.entities || {})) out[qid] = e.labels?.en?.value || e.labels?.ja?.value || qid;
  }
  return out;
}

const isHuman = entity => (entity.claims?.P31 || []).some(st => st.mainsnak?.datavalue?.value?.id === 'Q5');

// ── SPARQL一括選定 ──
const PRESETS = {
  'nobel-physics':        'SELECT ?person WHERE { ?person wdt:P166 wd:Q38104 ; wdt:P31 wd:Q5 . } LIMIT 300',
  'nobel-chemistry':      'SELECT ?person WHERE { ?person wdt:P166 wd:Q44585 ; wdt:P31 wd:Q5 . } LIMIT 300',
  'us-presidents':        'SELECT DISTINCT ?person WHERE { ?person wdt:P39 wd:Q11696 ; wdt:P31 wd:Q5 . }',
  'ancient-philosophers': 'SELECT DISTINCT ?person WHERE { ?person wdt:P106 wd:Q4964182 ; wdt:P31 wd:Q5 ; wdt:P569 ?dob . FILTER(YEAR(?dob) < 1) } LIMIT 200',
  'fields-medalists':     'SELECT ?person WHERE { ?person wdt:P166 wd:Q47170 ; wdt:P31 wd:Q5 . } LIMIT 100',
};

async function sparqlSelect(query) {
  const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  if (!r.ok) throw new Error(`WDQS HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const qids = [];
  for (const row of j.results.bindings)
    for (const v of Object.values(row)) { const m = /\/(Q\d+)$/.exec(v.value || ''); if (m) { qids.push(m[1]); break; } }
  return [...new Set(qids)];
}

async function pmap(items, concurrency, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function bulkImport(qids, opts) {
  const stamp = today();
  if (opts.out) mkdirSync(opts.out, { recursive: true });
  console.error(`fetching ${qids.length} entities (concurrency ${opts.concurrency})…`);
  const ents = (await pmap(qids, opts.concurrency, async qid => {
    try { return await fetchEntity(qid); } catch (e) { console.error(`  ✗ ${qid}: ${e.message}`); return null; }
  })).filter(Boolean);
  const humans = ents.filter(isHuman);
  console.error(`${humans.length} humans (${ents.length - humans.length} non-human skipped); resolving labels…`);
  const labels = await fetchLabels([...new Set(humans.flatMap(collectReferencedQids))]);
  let ok = 0, bad = 0; const lines = [];
  for (const e of humans) {
    const rec = entityToHRF(e, { labels, retrieved: stamp });
    const { E } = validateRecord(rec);
    if (E.length) { bad++; console.error(`  ✗ ${rec.id}: ${E[0]}`); continue; }
    if (opts.out) writeFileSync(join(opts.out, `wd-${e.id}.hrf`), JSON.stringify(rec, null, 2) + '\n');
    lines.push(JSON.stringify(rec)); ok++;
  }
  if (opts.hrfl) writeFileSync(opts.hrfl, lines.join('\n') + '\n');
  else if (!opts.out) for (const l of lines) console.log(l);
  console.error(`✓ ${ok} record(s)${bad ? `, ${bad} invalid` : ''}${opts.hrfl ? ` → ${opts.hrfl}` : ''}`);
}

function report(rec, path) {
  const { E, W } = validateRecord(rec);
  const tag = `${rec.id}${path ? ' → ' + path : ''}`;
  if (E.length) { console.error(`✗ ${tag}`); E.forEach(m => console.error(`    ERROR  ${m}`)); }
  else console.error(`✓ ${tag}  (${W.length} warning(s))`);
  return E.length === 0;
}

async function main(argv) {
  const opts = { out: null, hrfl: null, file: null, preset: null, sparqlFile: null, limit: null, concurrency: 6 };
  const qids = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--hrfl') opts.hrfl = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--preset') opts.preset = argv[++i];
    else if (a === '--sparql-file') opts.sparqlFile = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (/^Q\d+$/.test(a)) qids.push(a);
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }

  // SPARQL一括選定モード
  if (opts.preset || opts.sparqlFile) {
    let query = opts.preset ? PRESETS[opts.preset] : readFileSync(opts.sparqlFile, 'utf8');
    if (!query) { console.error(`unknown preset "${opts.preset}". available: ${Object.keys(PRESETS).join(', ')}`); process.exit(2); }
    if (opts.limit) query = query.replace(/\blimit\s+\d+/i, '').trim() + ` LIMIT ${opts.limit}`;
    if (opts.hrfl) mkdirSync(dirname(opts.hrfl), { recursive: true });
    const selected = await sparqlSelect(query);
    console.error(`WDQS → ${selected.length} QIDs`);
    await bulkImport(selected, opts);
    return;
  }

  if (!qids.length) { console.error('no QIDs given (e.g. Q7186), or use --preset <name> / --sparql-file <path>'); process.exit(2); }
  if (opts.out) mkdirSync(opts.out, { recursive: true });

  let fileEntities = null;
  if (opts.file) { const j = JSON.parse(readFileSync(opts.file, 'utf8')); fileEntities = j.entities || {}; }

  let ok = true;
  for (const qid of qids) {
    try {
      const entity = fileEntities ? (fileEntities[qid] || Object.values(fileEntities)[0]) : await fetchEntity(qid);
      if (!isHuman(entity)) { console.error(`⤼ skip ${qid}: not an instance of human (P31≠Q5)${entity.labels?.en ? `: "${entity.labels.en.value}"` : ''}`); continue; }
      const labels = opts.file ? {} : await fetchLabels(collectReferencedQids(entity));
      const rec = entityToHRF(entity, { labels, retrieved: today() });
      const json = JSON.stringify(rec, null, 2);
      if (opts.out) { const p = join(opts.out, `wd-${qid}.hrf`); writeFileSync(p, json + '\n'); ok = report(rec, p) && ok; }
      else if (opts.hrfl) { appendFileSync(opts.hrfl, JSON.stringify(rec) + '\n'); ok = report(rec, opts.hrfl) && ok; }
      else { ok = report(rec) && ok; console.log(json); }
    } catch (e) { console.error(`✗ ${qid}: ${e.message}`); ok = false; }
  }
  process.exit(ok ? 0 : 1);
}

function selftest() {
  let pass = 0;
  const ok = (c, m) => { if (c) pass++; else { console.error('  FAIL: ' + m); process.exitCode = 1; } };

  ok(wikidataTimeToEDTF({ time: '+1867-11-07T00:00:00Z', precision: 11 }) === '1867-11-07', 'day precision');
  ok(wikidataTimeToEDTF({ time: '+1867-00-00T00:00:00Z', precision: 9 }) === '1867', 'year precision');
  ok(wikidataTimeToEDTF({ time: '+1860-00-00T00:00:00Z', precision: 8 }) === '1860s', 'decade precision');
  ok(wikidataTimeToEDTF({ time: '+1801-00-00T00:00:00Z', precision: 7 }) === '18XX', 'century precision');
  ok(wikidataTimeToEDTF({ time: '-0044-03-15T00:00:00Z', precision: 11 }) === '-0044-03-15', 'BCE day');
  ok(wikidataTimeToEDTF({ time: '+1450-00-00T00:00:00Z', precision: 9 }, { circa: true }) === '1450~', 'circa marker');

  // 合成エンティティ(Curieの縮小版)を変換し、検証まで通す。
  const entity = {
    id: 'Q7186',
    labels: { en: { language: 'en', value: 'Marie Curie' }, ja: { language: 'ja', value: 'マリ・キュリー' }, pl: { language: 'pl', value: 'Maria Skłodowska-Curie' } },
    claims: {
      P1477: [{ mainsnak: { datavalue: { type: 'monolingualtext', value: { text: 'Maria Salomea Skłodowska', language: 'pl' } } }, rank: 'normal' }],
      P569: [{ mainsnak: { datavalue: { type: 'time', value: { time: '+1867-11-07T00:00:00Z', precision: 11 } } }, rank: 'normal' }],
      P19: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q270' } } }, rank: 'normal' }],
      P570: [{ mainsnak: { datavalue: { type: 'time', value: { time: '+1934-07-04T00:00:00Z', precision: 11 } } }, rank: 'normal' }],
      P27: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q142' } } }, qualifiers: { P580: [{ datavalue: { type: 'time', value: { time: '+1895-00-00T00:00:00Z', precision: 9 } } }] }, rank: 'normal' }],
      P106: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q169470' } } }, rank: 'normal' }],
      P26: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q37463' } } }, qualifiers: { P580: [{ datavalue: { type: 'time', value: { time: '+1895-07-26T00:00:00Z', precision: 11 } } }], P582: [{ datavalue: { type: 'time', value: { time: '+1906-04-19T00:00:00Z', precision: 11 } } }] }, rank: 'normal' }],
      P40: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q132787' } } }, rank: 'normal' }],
      P214: [{ mainsnak: { datavalue: { type: 'string', value: '75121530' } }, rank: 'normal' }]
    }
  };
  const labels = { Q270: 'Warsaw', Q142: 'France', Q169470: 'physicist' };
  const rec = entityToHRF(entity, { labels, retrieved: '2026-06-30' });

  ok(rec.id === 'hrf:person:wd-Q7186', 'self id derived from QID');
  ok(rec.status === 'deceased', 'death date → deceased');
  ok(rec.events.find(e => e.type === 'birth')?.when.edtf === '1867-11-07', 'birth event EDTF');
  ok(rec.events.find(e => e.type === 'birth')?.where.label === 'Warsaw', 'birthplace label resolved');
  ok(rec.claims.find(c => c.prop === 'citizenship')?.value.entity === 'France', 'citizenship label resolved');
  ok(rec.claims.find(c => c.prop === 'citizenship')?.valid.edtf === '1895/..', 'citizenship open-ended span');
  ok(rec.bonds.find(b => b.rel === 'spouse_of')?.with === 'hrf:person:wd-Q37463', 'spouse bond id');
  ok(rec.bonds.find(b => b.rel === 'spouse_of')?.valid.edtf === '1895-07-26/1906-04-19', 'marriage span');
  ok(rec.events.some(e => e.type === 'marriage'), 'marriage event created');
  ok(rec.bonds.some(b => b.rel === 'parent_of' && b.with === 'hrf:person:wd-Q132787'), 'child → parent_of bond');
  ok(rec.names.some(n => n.type === 'birth' && n.full === 'Maria Salomea Skłodowska'), 'birth name from P1477');
  ok(rec.identity.external_ids.some(x => x.scheme === 'viaf' && x.value === '75121530'), 'VIAF external id');
  ok(validateRecord(rec).E.length === 0, 'generated record passes HRF validation');

  console.log(process.exitCode ? `import selftest: FAILURES (${pass} passed)` : `import selftest: all ${pass} checks passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , ...argv] = process.argv;
  if (argv[0] === 'selftest') selftest();
  else main(argv);
}
