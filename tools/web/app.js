// 人類DB 閲覧フロント(バニラJS)。/api を叩いて人物ディレクトリ・ドシエ・関係グラフを描く。
const app = document.getElementById('app');
const search = document.getElementById('search');
const api = path => fetch(path).then(r => r.json());
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── EDTF → 日本語表記 ──
function edtfJa(e) {
  if (!e) return '不明';
  if (e.includes('/')) {
    const [a, b] = e.split('/');
    const A = (a === '' || a === '..') ? '' : edtfJa(a);
    const B = (b === '' || b === '..') ? '' : edtfJa(b);
    if (!A && !B) return '不明';
    if (!A) return `${B}以前`;
    if (!B) return `${A}〜`;
    return `${A}〜${B}`;
  }
  if (e.startsWith('[')) return e.slice(1, -1).split('..').map(edtfJa).join('〜') + ' のいずれか';
  const circa = /[~%]$/.test(e), unc = /\?$/.test(e);
  const core = e.replace(/[~?%]+$/, '');
  const yr = y => { const n = parseInt(y, 10); return n < 0 ? `紀元前${Math.abs(n)}` : `${n}`; };
  let m;
  if ((m = core.match(/^(-?\d{1,4})s$/))) return `${circa ? '約' : ''}${yr(m[1])}年代`;
  if ((m = core.match(/^(-?[0-9X]{4})(?:-(\d{2}))?(?:-(\d{2}))?$/))) {
    const [, y, mo, da] = m;
    if (/X/.test(y)) return `${y.replace(/X/g, '×')}年ごろ`;
    let s = `${yr(y)}年`;
    if (mo) s += `${+mo}月`;
    if (da) s += `${+da}日`;
    return `${circa ? '約' : ''}${s}${unc ? '?' : ''}`;
  }
  return core;
}

const PROP_JA = { citizenship: '国籍', occupation: '職業', sex_or_gender: '性別', residence: '居住地', religion: '宗教', education: '学歴', cause_of_death: '死因', field_of_work: '専門', member_of: '所属', language: '言語', height: '身長' };
const EVENT_JA = { birth: '誕生', death: '死去', marriage: '結婚', divorce: '離婚', award: '受賞', education: '就学', publication: '発表', migration: '移住', residence_change: '転居', imprisonment: '投獄', military_service: '兵役' };
const REL_JA = { spouse_of: '配偶者', parent_of: '子', child_of: '親', sibling_of: 'きょうだい', mentor_of: '弟子', student_of: '師', colleague_of: '同僚', friend_of: '友人' };
const EDGE_JA = { parent_of: '親子', spouse_of: '夫婦', sibling_of: 'きょうだい', mentor_of: '師弟', colleague_of: '同僚', friend_of: '友人' };
const EPI_JA = { attested: '記録あり', asserted: '主張', inferred: '推定', self: '本人申告', disputed: '異説あり' };

function srcChips(sources) {
  return (sources || []).map(s => {
    const label = s.kind === 'wikidata' ? `Wikidata:${s.ref}` : s.kind === 'self' ? '本人申告' : s.kind === 'archival' ? '一次資料' : s.kind || '出典';
    const href = s.kind === 'wikidata' ? `https://www.wikidata.org/wiki/${s.ref}` : (s.ref && /^https?:/.test(s.ref) ? s.ref : null);
    return href ? el('a', { class: 'src', href, target: '_blank', rel: 'noopener', title: s.ref }, label)
                : el('span', { class: 'src', title: s.ref || '' }, label);
  });
}
const epiBadge = (epi, conf) => epi ? el('span', { class: `epi ${epi}`, title: conf != null ? `確信度 ${Math.round(conf * 100)}%` : '' }, EPI_JA[epi] || epi) : null;

// ── ディレクトリ ──
async function renderList() {
  const all = await api('/api/people');
  const draw = q => {
    const list = q ? all.filter(p => (p.name || '').toLowerCase().includes(q.toLowerCase())) : all;
    app.replaceChildren(
      el('div', { class: 'dir-head' }, '人物一覧', el('small', {}, `${list.length} 名 / 全${all.length}名`)),
      el('div', { class: 'grid' }, list.map(p =>
        el('a', { class: 'card', href: `#/p/${encodeURIComponent(p.id)}` },
          el('div', { class: 'nm' }, p.name || '(無名)'),
          el('div', { class: 'lifespan' }, `${p.birth ? edtfJa(p.birth) : '?'} – ${p.death ? edtfJa(p.death) : (p.status === 'living' ? '存命' : '?')}`),
          el('div', { class: 'meta' },
            el('span', { class: `badge ${p.status}` }, { living: '存命', deceased: '故人', unknown: '不明' }[p.status]),
            el('span', {}, `言明 ${p.claims}`), el('span', {}, `出来事 ${p.events}`), el('span', {}, `関係 ${p.bonds}`))))));
  };
  draw(search.value.trim());
  search.oninput = () => { if (location.hash === '#/' || location.hash === '') draw(search.value.trim()); };
}

// ── 人物ページ ──
async function renderPerson(id) {
  const d = await api('/api/person?id=' + encodeURIComponent(id));
  if (d.error) { app.replaceChildren(el('p', {}, '見つかりませんでした。'), el('a', { class: 'back', href: '#/' }, '← 一覧へ')); return; }

  const primary = d.names.find(n => n.type === 'legal') || d.names.find(n => n.type === 'birth') || d.names[0] || {};
  const aka = d.names.filter(n => n !== primary);

  const idLinks = el('div', { class: 'idlinks' }, d.external_ids.map(x => {
    const href = x.scheme === 'wikidata' ? `https://www.wikidata.org/wiki/${x.value}` : x.scheme === 'viaf' ? `https://viaf.org/viaf/${x.value}` : x.scheme === 'orcid' ? `https://orcid.org/${x.value}` : null;
    return href ? el('a', { href, target: '_blank', rel: 'noopener' }, `${x.scheme}: ${x.value}`) : el('span', {}, `${x.scheme}: ${x.value}`);
  }));

  // タイムライン
  const timeline = el('div', { class: 'timeline' }, d.events.map(e =>
    el('div', { class: `ev ${e.type}` },
      el('span', { class: 'when' }, edtfJa(e.when_edtf)),
      el('span', { class: 'ev-type' }, EVENT_JA[e.type] || e.type),
      el('span', { class: 'what' }, e.label || ''),
      e.place_label ? el('span', { class: 'where' }, ` — ${e.place_label}`) : null,
      el('div', { class: 'chips' }, epiBadge(e.epistemic, e.confidence), srcChips(e.sources)))));

  // 言明(propごと)
  const byProp = {};
  for (const c of d.claims) (byProp[c.prop] ||= []).push(c);
  const facts = el('div', { class: 'facts' }, Object.entries(byProp).map(([prop, cs]) =>
    el('div', { class: 'fact' },
      el('div', { class: 'label' }, PROP_JA[prop] || prop),
      ...cs.map(c => el('div', {},
        el('span', { class: 'val' }, valText(c.value)),
        c.valid_edtf ? el('span', { class: 'period' }, `（${edtfJa(c.valid_edtf)}）`) : null,
        el('span', { class: 'chips' }, epiBadge(c.epistemic, c.confidence), srcChips(c.sources)))))));

  // 関係
  const rels = el('div', { class: 'rels' }, d.bonds.map(b =>
    el('div', { class: 'rel-row' },
      el('span', { class: 'kind' }, REL_JA[b.rel] || b.rel),
      b.with_real ? el('a', { href: `#/p/${encodeURIComponent(b.with_id)}` }, b.with_name)
                  : el('span', { class: 'stub' }, `${b.with_name || b.with_id.replace('hrf:person:wd-', '')}（未収録）`),
      b.valid_edtf ? el('span', { class: 'period' }, ` ${edtfJa(b.valid_edtf)}`) : null)));

  app.replaceChildren(...[
    el('a', { class: 'back', href: '#/' }, '← 一覧へ'),
    el('div', { class: 'person-head' },
      el('h1', { class: 'person-name' }, primary.full || '(無名)'),
      aka.length ? el('div', { class: 'person-aka' }, '別称: ', aka.map((n, i) =>
        el('span', {}, (i ? ' / ' : ''), n.full, n.script && n.script !== 'Latn' ? el('span', { class: 'script' }, n.script) : null)) ) : null,
      idLinks),
    d.hidden.length ? el('div', { class: 'notice' }, `本人の公開設定により ${d.hidden.map(h => PROP_JA[h] || h).join('・')} は非表示です。`) : null,
    section('一生（タイムライン）', timeline),
    Object.keys(byProp).length ? section('言明', facts) : null,
    d.bonds.length ? section('関係', rels, graphSlot(id)) : null,
  ].filter(Boolean));

  if (d.bonds.length) drawGraph(id);
}
const section = (title, ...body) => el('div', { class: 'section' }, el('h2', {}, title), ...body);
const graphSlot = id => el('div', { class: 'graph-wrap', id: 'graph' });
function valText(v) {
  if (v == null) return '';
  if (v.entity) return v.entity;
  if (v.text) return v.text;
  if (v.number != null) return String(v.number);
  return JSON.stringify(v);
}

// ── 関係グラフ(SVG ego network) ──
async function drawGraph(id) {
  const g = await api('/api/graph?id=' + encodeURIComponent(id));
  const slot = document.getElementById('graph');
  if (!slot) return;
  const W = 660, H = 420, cx = W / 2, cy = H / 2, R = Math.min(170, 120 + g.nodes.length * 6);
  const others = g.nodes.filter(n => n.id !== id);
  const pos = new Map([[id, [cx, cy]]]);
  others.forEach((n, i) => { const a = -Math.PI / 2 + (i / others.length) * Math.PI * 2; pos.set(n.id, [cx + R * Math.cos(a), cy + R * Math.sin(a)]); });
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mk = (t, a) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); return n; };

  for (const e of g.edges) {
    const p1 = pos.get(e.src), p2 = pos.get(e.dst); if (!p1 || !p2) continue;
    svg.append(mk('line', { class: 'gedge', x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }));
    const t = mk('text', { class: 'gedge-label', x: (p1[0] + p2[0]) / 2, y: (p1[1] + p2[1]) / 2 - 3, 'text-anchor': 'middle' });
    t.textContent = EDGE_JA[e.rel] || e.rel; svg.append(t);
  }
  for (const n of g.nodes) {
    const [x, y] = pos.get(n.id); const isEgo = n.id === id;
    const grp = mk('g', { class: 'gnode' + (n.real ? ' real' : '') });
    if (n.real && !isEgo) grp.addEventListener('click', () => { location.hash = '#/p/' + encodeURIComponent(n.id); });
    grp.append(mk('circle', {
      cx: x, cy: y, r: isEgo ? 30 : 24,
      fill: isEgo ? 'var(--accent)' : n.real ? 'var(--paper)' : 'transparent',
      stroke: isEgo ? 'var(--accent)' : n.real ? 'var(--accent-soft)' : 'var(--line)',
      'stroke-width': 2, 'stroke-dasharray': n.real ? '0' : '4 3'
    }));
    const label = mk('text', { x, y: y + (isEgo ? 46 : 40), 'text-anchor': 'middle', fill: isEgo ? 'var(--accent)' : 'var(--ink)' });
    label.textContent = (n.name || n.id.replace('hrf:person:wd-', '')).slice(0, 12);
    if (isEgo) label.setAttribute('font-weight', '700');
    grp.append(label); svg.append(grp);
  }
  slot.replaceChildren(svg);
}

// ── ルータ ──
function route() {
  const h = location.hash || '#/';
  app.replaceChildren(el('div', { class: 'loading' }, '読み込み中…'));
  const m = h.match(/^#\/p\/(.+)$/);
  if (m) { search.style.visibility = 'hidden'; renderPerson(decodeURIComponent(m[1])); }
  else { search.style.visibility = 'visible'; renderList(); }
}
addEventListener('hashchange', route);
route();
