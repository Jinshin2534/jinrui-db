// Wikidata エンティティ(Special:EntityData JSON)→ HRF Person Record への純粋変換。ネットワーク非依存。
// 関連人物は QID 由来の決定的ID hrf:person:wd-<QID> で参照する(未取込でもリンクが繋がる)。

const SCRIPT = { en: 'Latn', fr: 'Latn', pl: 'Latn', de: 'Latn', es: 'Latn', it: 'Latn', pt: 'Latn', nl: 'Latn', la: 'Latn', ja: 'Jpan', ru: 'Cyrl', uk: 'Cyrl', zh: 'Hani', ko: 'Kore', ar: 'Arab', el: 'Grek', he: 'Hebr' };
const scriptOf = l => SCRIPT[l] || 'Latn';

export const hrfId = qid => `hrf:person:wd-${qid}`;

const pad4 = y => { const n = y < 0; return (n ? '-' : '') + String(Math.abs(y)).padStart(4, '0'); };

// Wikidata time datavalue → EDTF。precision: 11=日 10=月 9=年 8=年代 7=世紀。BCEは負年、circaで ~ を付す。
export function wikidataTimeToEDTF(value, { circa = false } = {}) {
  if (!value || typeof value.time !== 'string') return null;
  const m = value.time.match(/^([+-])(\d+)-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const yNum = parseInt((m[1] === '-' ? '-' : '') + m[2], 10);
  const mo = m[3], da = m[4];
  let edtf;
  switch (value.precision) {
    case 11: edtf = `${pad4(yNum)}-${mo}-${da}`; break;
    case 10: edtf = `${pad4(yNum)}-${mo}`; break;
    case 9:  edtf = `${pad4(yNum)}`; break;
    case 8:  edtf = `${pad4(Math.trunc(yNum / 10) * 10)}s`; break;
    case 7:  edtf = `${(yNum < 0 ? '-' : '') + String(Math.abs(Math.trunc(yNum / 100))).padStart(2, '0')}XX`; break;
    default: edtf = `${pad4(yNum)}`; break; // それ以外(千年紀など)は年精度で最善努力
  }
  return circa ? edtf + '~' : edtf;
}

const rankConf = r => (r === 'preferred' ? 0.95 : r === 'deprecated' ? 0.4 : 0.9);
const rankEpi = r => (r === 'deprecated' ? 'disputed' : 'attested');

const entId = snak => snak?.datavalue?.value?.id || null;
const strVal = st => { const dv = st?.mainsnak?.datavalue; return dv?.type === 'string' ? dv.value : (dv?.value?.text ?? null); };
const hasCirca = st => (st.qualifiers?.P1480 || []).some(s => entId(s) === 'Q5727902');
const timeEDTF = st => { const dv = st?.mainsnak?.datavalue; return dv?.type === 'time' ? wikidataTimeToEDTF(dv.value, { circa: hasCirca(st) }) : null; };
const qualEDTF = (st, pid) => { const s = (st.qualifiers?.[pid] || [])[0]; return s?.datavalue?.type === 'time' ? wikidataTimeToEDTF(s.datavalue.value) : null; };
const spanEDTF = (start, end) => (start || end) ? { edtf: `${start || '..'}/${end || '..'}` } : undefined;

// ラベル解決が要る参照先(出生地・国籍・職業など)のQIDを集める。
export function collectReferencedQids(entity) {
  const out = new Set();
  for (const pid of ['P19', 'P20', 'P27', 'P106', 'P21', 'P166'])
    for (const st of (entity.claims?.[pid] || [])) { const id = entId(st.mainsnak); if (id) out.add(id); }
  return [...out];
}

export function entityToHRF(entity, { labels = {}, retrieved = '0000-00-00' } = {}) {
  const qid = entity.id;
  const self = hrfId(qid);
  const claims = pid => entity.claims?.[pid] || [];
  const first = pid => claims(pid)[0];
  const L = entity.labels || {};
  const lbl = id => labels[id] || id;

  // ── 名前 ──
  const names = [], seen = new Set();
  const pushName = (full, type, lang) => {
    if (!full) return; const k = `${full}|${lang || ''}`; if (seen.has(k)) return; seen.add(k);
    names.push({ type, full, script: scriptOf(lang), lang, epistemic: 'attested', confidence: 0.9, src: ['src:wd'] });
  };
  for (const st of claims('P1477')) { const v = st.mainsnak?.datavalue?.value; if (v?.text) pushName(v.text, 'birth', v.language); }
  const legalLang = L.en ? 'en' : Object.keys(L)[0];
  if (legalLang) pushName(L[legalLang].value, 'legal', legalLang);
  for (const lang of ['ja', 'pl', 'fr', 'de', 'ru']) if (L[lang]) pushName(L[lang].value, lang === 'ja' ? 'romanization' : 'other', lang);

  // ── イベント ──
  const events = [];
  const place = pid => { const id = entId(first(pid)?.mainsnak); return id ? { label: lbl(id), ref: { scheme: 'wikidata', value: id } } : undefined; };
  if (first('P569')) events.push(trim({ id: 'e:birth', type: 'birth', when: edtfObj(timeEDTF(first('P569'))), where: place('P19'), epistemic: rankEpi(first('P569').rank), confidence: rankConf(first('P569').rank), src: ['src:wd'] }));
  if (first('P570')) events.push(trim({ id: 'e:death', type: 'death', when: edtfObj(timeEDTF(first('P570'))), where: place('P20'), epistemic: rankEpi(first('P570').rank), confidence: rankConf(first('P570').rank), src: ['src:wd'] }));
  for (const st of claims('P166')) {
    const aid = entId(st.mainsnak); if (!aid) continue;
    events.push(trim({ id: `e:award-${aid}`, type: 'award', label: lbl(aid), when: edtfObj(qualEDTF(st, 'P585')), participants: [{ role: 'self', person: self }], epistemic: 'attested', confidence: rankConf(st.rank), src: ['src:wd'] }));
  }

  // ── 関係(＋結婚イベント) ──
  const bonds = [];
  for (const st of claims('P26')) {
    const sp = entId(st.mainsnak); if (!sp) continue;
    const start = qualEDTF(st, 'P580'), end = qualEDTF(st, 'P582');
    let via;
    if (start || end) { via = `e:marriage-${sp}`; events.push(trim({ id: via, type: 'marriage', when: edtfObj(start), participants: [{ role: 'self', person: self }, { role: 'spouse', person: hrfId(sp) }], epistemic: 'attested', confidence: 0.9, src: ['src:wd'] })); }
    bonds.push(trim({ id: `b:spouse-${sp}`, rel: 'spouse_of', with: hrfId(sp), valid: spanEDTF(start, end), via_event: via, epistemic: rankEpi(st.rank), confidence: rankConf(st.rank), src: ['src:wd'] }));
  }
  const relBonds = (pid, rel) => { for (const st of claims(pid)) { const id = entId(st.mainsnak); if (id) bonds.push(trim({ id: `b:${rel}-${id}`, rel, with: hrfId(id), epistemic: rankEpi(st.rank), confidence: rankConf(st.rank), src: ['src:wd'] })); } };
  relBonds('P40', 'parent_of');
  relBonds('P22', 'child_of');
  relBonds('P25', 'child_of');
  relBonds('P3373', 'sibling_of');
  relBonds('P1066', 'student_of');   // 師事した相手
  relBonds('P184', 'student_of');    // 博士課程の指導教員
  relBonds('P802', 'mentor_of');     // 教え子
  relBonds('P185', 'mentor_of');     // 博士課程の教え子

  // ── claim(国籍・職業・性別) ──
  const claimList = [];
  const entityClaim = (pid, prop, withTime) => { for (const st of claims(pid)) { const id = entId(st.mainsnak); if (!id) continue; claimList.push(trim({ id: `c:${prop}-${id}`, prop, value: { entity: lbl(id), ref: { scheme: 'wikidata', value: id } }, valid: withTime ? spanEDTF(qualEDTF(st, 'P580'), qualEDTF(st, 'P582')) : undefined, epistemic: rankEpi(st.rank), confidence: rankConf(st.rank), src: ['src:wd'] })); } };
  entityClaim('P27', 'citizenship', true);
  entityClaim('P106', 'occupation', false);
  entityClaim('P21', 'sex_or_gender', false);

  // ── 外部ID ──
  const external_ids = [{ scheme: 'wikidata', value: qid }];
  if (strVal(first('P214'))) external_ids.push({ scheme: 'viaf', value: strVal(first('P214')) });
  if (strVal(first('P496'))) external_ids.push({ scheme: 'orcid', value: strVal(first('P496')) });

  return {
    hrf: '0.1', id: self, kind: 'person',
    status: first('P570') ? 'deceased' : 'unknown',
    identity: { external_ids, same_as: [], merged_into: null, split_from: null },
    names, claims: uniqById(claimList), events: uniqById(events), bonds: uniqById(bonds),
    sources: [{ id: 'src:wd', kind: 'wikidata', ref: qid, retrieved, reliability: 'tertiary', license: 'CC0-1.0', signature: null }],
    meta: { created: retrieved, source: 'wikidata', via: 'import-wikidata' }
  };
}

function edtfObj(edtf) { return edtf ? { edtf } : undefined; }
// undefined のフィールドを落とす(出力をきれいに保つ)。
function trim(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }
// 同一idの重複を畳む(同じ相手が複数プロパティで参照される等)。
function uniqById(arr) { const seen = new Set(); return arr.filter(x => !seen.has(x.id) && seen.add(x.id)); }
