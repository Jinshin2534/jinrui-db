// EDTF (ISO 8601-2 / Library of Congress Extended Date/Time Format) の検証と通日変換。
// HRFの valid/when で使う日付のあいまいさ表現を扱う。バリデータと将来のPostgres取込で共用する。

// 符号付き通日(1970-01-01 = 0)。紀元前(負の年)も正しく扱う proleptic Gregorian。
// Howard Hinnant, days_from_civil。
export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function lastDay(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }

// 単一の日付トークンか? 例: 1879-03-14 / 1450~ / 15XX / 198X / 1620s / 1867-11 / -0044
export function isDateToken(t) {
  if (typeof t !== 'string' || t === '') return false;
  const core = t.replace(/[~?%]+$/, ''); // 末尾の不確実性修飾子を除去
  if (/^-?\d{1,4}s$/.test(core)) return true;        // 1620s (decade, 非公式)
  if (/^Y-?\d{5,}$/.test(core)) return true;         // 長い年 Y170000
  const m = core.match(/^(-?[0-9X]{4})(?:-([0-9X]{2}))?(?:-([0-9X]{2}))?$/);
  if (!m) return false;
  const mo = m[2], da = m[3];
  if (mo && !/X/.test(mo)) { const n = +mo; if (!((n >= 1 && n <= 12) || (n >= 21 && n <= 41))) return false; }
  if (da && !/X/.test(da)) { const n = +da; if (!(n >= 1 && n <= 31)) return false; }
  return true;
}

// EDTF文字列として妥当か(単一/期間/集合に対応)。
export function isValidEDTF(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (!s.length) return false;
  if (s.startsWith('[') || s.startsWith('{')) {           // 集合 one-of/all-of
    if (!(s.endsWith(']') || s.endsWith('}'))) return false;
    const inner = s.slice(1, -1);
    if (!inner.length) return false;
    return inner.split(',').every(part => {
      part = part.trim();
      if (part.includes('..')) {                          // 範囲 a..b
        const [a, b] = part.split('..');
        return (a === '' || isDateToken(a)) && (b === '' || isDateToken(b));
      }
      return isDateToken(part);
    });
  }
  if (s.includes('/')) {                                   // 期間 a/b(開区間 .. / 不明 空)
    const parts = s.split('/');
    if (parts.length !== 2) return false;
    const [a, b] = parts;
    const okA = a === '' || a === '..' || isDateToken(a);
    const okB = b === '' || b === '..' || isDateToken(b);
    return okA && okB && (a !== '' || b !== '');
  }
  return isDateToken(s);
}

// トークンの最早/最遅の通日。side: 'from' | 'to'
function tokenBounds(tok, side) {
  const core = tok.replace(/[~?%]+$/, '').trim();
  let m;
  if ((m = core.match(/^(-?\d{1,4})s$/))) {
    const base = +m[1];
    return side === 'from' ? daysFromCivil(base, 1, 1) : daysFromCivil(base + 9, 12, 31);
  }
  if ((m = core.match(/^Y(-?\d{5,})$/))) {
    const y = +m[1];
    return side === 'from' ? daysFromCivil(y, 1, 1) : daysFromCivil(y, 12, 31);
  }
  m = core.match(/^(-?[0-9X]{4})(?:-([0-9X]{2}))?(?:-([0-9X]{2}))?$/);
  if (!m) return null;
  const yNum = parseInt(m[1].replace(/X/g, side === 'from' ? '0' : '9'), 10);
  let month, day;
  if (!m[2] || /X/.test(m[2])) month = side === 'from' ? 1 : 12;
  else { month = +m[2]; if (month >= 21) month = side === 'from' ? 1 : 12; } // 季節は年全体に近似
  if (!m[3] || /X/.test(m[3])) day = side === 'from' ? 1 : lastDay(yNum, month);
  else day = Math.min(+m[3], lastDay(yNum, month));
  return daysFromCivil(yNum, month, day);
}

// EDTF → {fromNum, toNum}(符号付き通日。開区間/不明は null = 無限)。Postgresの valid_from_num/to_num 用。
export function edtfBounds(s) {
  if (!isValidEDTF(s)) return { fromNum: null, toNum: null, valid: false };
  s = s.trim();
  const open = t => t === '' || t === '..';
  if (s.startsWith('[') || s.startsWith('{')) {
    const froms = [], tos = [];
    s.slice(1, -1).split(',').forEach(p => {
      p = p.trim();
      if (p.includes('..')) { const [a, b] = p.split('..'); if (!open(a)) froms.push(tokenBounds(a, 'from')); if (!open(b)) tos.push(tokenBounds(b, 'to')); }
      else { froms.push(tokenBounds(p, 'from')); tos.push(tokenBounds(p, 'to')); }
    });
    return { fromNum: froms.length ? Math.min(...froms) : null, toNum: tos.length ? Math.max(...tos) : null, valid: true };
  }
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    return { fromNum: open(a) ? null : tokenBounds(a, 'from'), toNum: open(b) ? null : tokenBounds(b, 'to'), valid: true };
  }
  return { fromNum: tokenBounds(s, 'from'), toNum: tokenBounds(s, 'to'), valid: true };
}
