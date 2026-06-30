#!/usr/bin/env node
// HRF (Human Record Format) のCLI: .hrf / .hrfl の検証・要約・自己テスト。依存ゼロ。
//   hrf validate <files|dirs...>   形式とクロス参照(出典解決・EDTF・同意範囲など)を検証
//   hrf info     <files|dirs...>   1レコード=1行で要約(氏名・生没・件数)
//   hrf selftest                   EDTFパーサと検証器の内蔵テスト
import { isValidEDTF, edtfBounds } from './edtf.mjs';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const EPI = ['attested', 'asserted', 'inferred', 'self', 'disputed'];
const VIS = ['public', 'researchers', 'private'];
const SRC_KINDS = ['wikidata', 'url', 'book', 'archival', 'census', 'oral', 'self'];

export function validateRecord(rec) {
  const E = [], W = [];
  const err = (p, m) => E.push(`${p}: ${m}`);
  const warn = (p, m) => W.push(`${p}: ${m}`);
  if (rec == null || typeof rec !== 'object') { err('$', 'record must be a JSON object'); return { E, W }; }

  if (rec.hrf !== '0.1') warn('hrf', `expected "0.1", got ${JSON.stringify(rec.hrf)}`);
  if (typeof rec.id !== 'string' || !/^hrf:person:[0-9A-Za-z_-]+$/.test(rec.id)) err('id', 'must match ^hrf:person:[0-9A-Za-z_-]+$');
  if (rec.kind !== 'person') err('kind', 'must be "person"');
  if (!['living', 'deceased', 'unknown'].includes(rec.status)) err('status', 'must be living|deceased|unknown');

  const srcIds = new Set((rec.sources || []).map(s => s && s.id).filter(Boolean));
  const eventIds = new Set((rec.events || []).map(e => e && e.id).filter(Boolean));

  const common = (o, p) => {
    if (o.epistemic != null && !EPI.includes(o.epistemic)) err(`${p}.epistemic`, `must be one of ${EPI.join('|')}`);
    if (o.confidence != null && (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1)) err(`${p}.confidence`, 'must be a number in 0..1');
    if (o.valid && o.valid.edtf != null && !isValidEDTF(o.valid.edtf)) err(`${p}.valid.edtf`, `invalid EDTF: ${o.valid.edtf}`);
    if (Array.isArray(o.src)) o.src.forEach((s, i) => { if (!srcIds.has(s)) err(`${p}.src[${i}]`, `unresolved source id "${s}"`); });
  };

  (rec.sources || []).forEach((s, i) => {
    const p = `sources[${i}]`;
    if (!s || typeof s !== 'object') { err(p, 'must be an object'); return; }
    if (!s.id) err(`${p}.id`, 'required');
    if (!SRC_KINDS.includes(s.kind)) err(`${p}.kind`, `must be one of ${SRC_KINDS.join('|')}`);
  });

  if (!Array.isArray(rec.names) || rec.names.length === 0) warn('names', 'no names (a human record usually has at least one)');
  (rec.names || []).forEach((n, i) => {
    const p = `names[${i}]`;
    if (!n || typeof n.full !== 'string' || !n.full.length) err(`${p}.full`, 'required non-empty string');
    common(n || {}, p);
  });

  (rec.claims || []).forEach((c, i) => {
    const p = `claims[${i}]`;
    if (!c || typeof c !== 'object') { err(p, 'must be an object'); return; }
    if (typeof c.prop !== 'string' || !c.prop) err(`${p}.prop`, 'required');
    if (c.value == null || typeof c.value !== 'object') err(`${p}.value`, 'required object');
    if (c.id == null) warn(p, 'missing id (recommended for stable reference)');
    common(c, p);
  });

  (rec.events || []).forEach((e, i) => {
    const p = `events[${i}]`;
    if (!e || typeof e !== 'object') { err(p, 'must be an object'); return; }
    if (typeof e.type !== 'string' || !e.type) err(`${p}.type`, 'required');
    if (e.when && e.when.edtf != null && !isValidEDTF(e.when.edtf)) err(`${p}.when.edtf`, `invalid EDTF: ${e.when.edtf}`);
    if (e.where && Array.isArray(e.where.geo)) {
      const [la, lo] = e.where.geo;
      if (typeof la !== 'number' || la < -90 || la > 90) warn(`${p}.where.geo[0]`, 'latitude out of range');
      if (typeof lo !== 'number' || lo < -180 || lo > 180) warn(`${p}.where.geo[1]`, 'longitude out of range');
    }
    (e.participants || []).forEach((pt, j) => {
      const pp = `${p}.participants[${j}]`;
      if (!pt || typeof pt.role !== 'string' || !pt.role) err(`${pp}.role`, 'required');
      if (pt && pt.person != null && !/^hrf:person:/.test(pt.person)) warn(`${pp}.person`, 'should be an hrf:person: id');
    });
    common(e, p);
  });

  (rec.bonds || []).forEach((b, i) => {
    const p = `bonds[${i}]`;
    if (!b || typeof b !== 'object') { err(p, 'must be an object'); return; }
    if (typeof b.rel !== 'string' || !b.rel) err(`${p}.rel`, 'required');
    if (typeof b.with !== 'string' || !/^hrf:person:/.test(b.with)) err(`${p}.with`, 'required hrf:person: id');
    if (b.via_event != null && !eventIds.has(b.via_event)) warn(`${p}.via_event`, `references unknown event id "${b.via_event}"`);
    common(b, p);
  });

  if (rec.identity) {
    (rec.identity.external_ids || []).forEach((x, i) => {
      const p = `identity.external_ids[${i}]`;
      if (!x || !x.scheme) err(`${p}.scheme`, 'required');
      if (!x || x.value == null) err(`${p}.value`, 'required');
    });
    if (rec.identity.merged_into) warn('identity.merged_into', 'record is a tombstone; consumers should resolve to the canonical id');
  }

  if (rec.status === 'living' && !rec.stewardship) warn('stewardship', 'living record without stewardship (unclaimed)');
  if (rec.consent && rec.consent.fields) {
    for (const [k, v] of Object.entries(rec.consent.fields))
      if (!VIS.includes(v)) err(`consent.fields.${k}`, `visibility must be ${VIS.join('|')}`);
  }
  if (rec.stewardship) {
    if (typeof rec.stewardship.account !== 'string' || !/^hrf:account:/.test(rec.stewardship.account)) err('stewardship.account', 'required hrf:account: id');
    const hasSelf = [...(rec.names || []), ...(rec.claims || []), ...(rec.events || [])].some(o => o && o.epistemic === 'self');
    const signed = (rec.sources || []).some(s => s && s.kind === 'self' && s.signature);
    if (hasSelf && !signed) warn('sources', 'has self-attested data but no signed self source (recommended for verifiability)');
  }

  return { E, W };
}

function summarize(rec) {
  const names = rec.names || [];
  const name = names.find(n => n && n.type === 'legal') || names.find(n => n && n.type === 'birth') || names[0];
  const birth = (rec.events || []).find(e => e && e.type === 'birth');
  const death = (rec.events || []).find(e => e && e.type === 'death');
  const span = `${birth?.when?.edtf ?? '?'}–${death?.when?.edtf ?? (rec.status === 'living' ? '存命' : '?')}`;
  const counts = `claims:${(rec.claims || []).length} events:${(rec.events || []).length} bonds:${(rec.bonds || []).length}`;
  return `${name?.full ?? '(no name)'}  [${span}]  ${counts}  ${rec.id ?? ''}`;
}

function loadRecords(path) {
  const text = readFileSync(path, 'utf8');
  if (extname(path) === '.hrfl') {
    return text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter(x => x.raw.trim().length)
      .map(x => { try { return { rec: JSON.parse(x.raw), line: x.line }; } catch (e) { return { error: e.message, line: x.line }; } });
  }
  try { return [{ rec: JSON.parse(text), line: 1 }]; } catch (e) { return [{ error: e.message, line: 1 }]; }
}

function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { out.push(p); continue; }
    if (st.isDirectory()) for (const f of readdirSync(p)) { if (f.endsWith('.hrf') || f.endsWith('.hrfl')) out.push(join(p, f)); }
    else out.push(p);
  }
  return out;
}

function cmdValidate(paths) {
  let totalErr = 0, totalRec = 0, files = 0;
  for (const path of expand(paths)) {
    files++;
    for (const item of loadRecords(path)) {
      totalRec++;
      const tag = extname(path) === '.hrfl' ? `${path}:${item.line}` : path;
      if (item.error) { console.log(`✗ ${tag}\n    parse error: ${item.error}`); totalErr++; continue; }
      const { E, W } = validateRecord(item.rec);
      const id = item.rec?.id ?? '?';
      if (E.length === 0 && W.length === 0) { console.log(`✓ ${tag}  (${id})`); }
      else {
        console.log(`${E.length ? '✗' : '⚠'} ${tag}  (${id})`);
        E.forEach(m => console.log(`    ERROR  ${m}`));
        W.forEach(m => console.log(`    warn   ${m}`));
      }
      totalErr += E.length;
    }
  }
  console.log(`\n${totalErr ? '✗' : '✓'} ${totalRec} record(s) in ${files} file(s), ${totalErr} error(s)`);
  process.exit(totalErr ? 1 : 0);
}

function cmdInfo(paths) {
  for (const path of expand(paths))
    for (const item of loadRecords(path))
      console.log(item.error ? `! ${path}:${item.line} parse error: ${item.error}` : summarize(item.rec));
}

function cmdSelftest() {
  let pass = 0;
  const ok = (c, msg) => { if (c) pass++; else { console.error('  FAIL: ' + msg); process.exitCode = 1; } };

  ['1879-03-14', '1450~', '1450?', '1450%', '15XX', '198X', '1620s', '1867-11',
    '[1450..1455]', '../1500', '1600/..', '1895-07-26/1906-04-19', '-0044'
  ].forEach(s => ok(isValidEDTF(s), `EDTF should be valid: ${s}`));
  ['', '/', 'abc', '2020-13', '1450-00-00', '19/99', '[1450', '1450/1460/1470'
  ].forEach(s => ok(!isValidEDTF(s), `EDTF should be invalid: ${s}`));

  const exact = edtfBounds('1879-03-14'); ok(exact.fromNum === exact.toNum, 'exact date: from == to');
  ok(edtfBounds('1620s').fromNum < edtfBounds('1620s').toNum, 'decade spans a range');
  ok(edtfBounds('1600/..').toNum === null, 'open end → null toNum');
  ok(edtfBounds('-0044').fromNum < edtfBounds('0044').fromNum, 'BCE sorts before AD');

  const good = {
    hrf: '0.1', id: 'hrf:person:01ABC', kind: 'person', status: 'deceased',
    names: [{ type: 'legal', full: 'X', epistemic: 'attested', confidence: 1, src: ['s'] }],
    sources: [{ id: 's', kind: 'self' }]
  };
  ok(validateRecord(good).E.length === 0, 'good record has no errors');

  const bad = {
    hrf: '0.1', id: 'person:bad', kind: 'person', status: 'x',
    claims: [{ prop: 'p', value: {}, confidence: 9, src: ['nope'] }]
  };
  ok(validateRecord(bad).E.length >= 3, 'bad record flagged (id, status, confidence, unresolved src)');

  console.log(process.exitCode ? `selftest: FAILURES (${pass} passed)` : `selftest: all ${pass} checks passed`);
}

function usage() {
  console.log(`HRF tools — Human Record Format (.hrf / .hrfl)

  hrf validate <files|dirs...>   validate structure, EDTF, source cross-refs, consent
  hrf info     <files|dirs...>   one-line summary per record
  hrf selftest                   run built-in tests

  .hrf   = one Person Record (JSON)
  .hrfl  = HRF Lines: one Person Record per line (NDJSON), for bulk import/export`);
}

// 直接実行されたときだけCLIを動かす(他モジュールから validateRecord 等を import しても副作用なし)。
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'validate': if (!rest.length) { usage(); process.exit(2); } cmdValidate(rest); break;
    case 'info': if (!rest.length) { usage(); process.exit(2); } cmdInfo(rest); break;
    case 'selftest': cmdSelftest(); break;
    default: usage(); process.exit(cmd ? 2 : 0);
  }
}
