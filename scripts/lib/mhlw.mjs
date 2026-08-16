/**
 * 厚労省サイトから供給状況xlsxを見つけて落とし、検証しながら正規化する。
 *
 * 方針：
 *  - 曖昧な状態で先へ進まない。リンクが0本でも2本でも、列が違っても、行数が想定外でも例外で止める。
 *    （共通ノウハウ E-13：「比較できなかった」を「一致した」として扱う実装を書かない）
 *  - セルの中身は言い換えない。不可視文字（NUL・ゼロ幅・BOM）だけ落とす（E-7）。
 */
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { COLUMNS, SHEET_NAME, HEADER_ROW, FIRST_DATA_ROW, SANE_ROW_RANGE } from './schema.mjs';

export const PAGE_URL =
  'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iryou/kouhatu-iyaku/04_00003.html';

const UA = 'SupplyControl/0.1 (+https://github.com/morimoriflower/supply-control) personal use';

/**
 * 不可視文字を落とす。NUL・ゼロ幅スペース・BOM は「空白ではない」ので trim() では消えない（E-7）。
 * ここを通していないと、見た目が同じ文字列が別キー扱いになり、差分が全件変化に化ける。
 * ※文字は必ずエスケープ表記で書く（コードに直接埋めると目視で判別できず、この罠そのものになる）
 */
const INVISIBLE = new RegExp('[\\u0000\\u200B\\u200C\\u200D\\u2060\\uFEFF]', 'g');
const clean = (s) => String(s).replace(INVISIBLE, '').trim();

/** Excelのシリアル値 → ISO日付。基準は 1899-12-30 */
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
export function serialToISO(n) {
  if (!Number.isFinite(n) || n < 61 || n > 100000) return null;
  return new Date(SERIAL_EPOCH + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

/** セルの値を文字列にする。ExcelJSは型がまちまちなので全部ここで受ける */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v.error !== undefined) return '';
    return String(v);
  }
  return String(v);
}

/** 日付列の値。数値ならISO日付へ、文字列（「薬価基準未収載」等）はそのまま残す */
function cellDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const raw = cellText(v);
  if (raw === '') return '';
  const n = Number(raw);
  if (Number.isFinite(n)) {
    const iso = serialToISO(n);
    if (iso) return iso;
  }
  return clean(raw);
}

/** 全角英数を半角に寄せる（和暦の抽出用。元データの保存には使わない） */
const toHalf = (s) => s.normalize('NFKC');

/**
 * 掲載ページを読み、xlsxの場所と「◯年◯月◯日現在」を取り出す。
 * リンクが1本でなければ止める（F-4：黙って先頭を選ばない）。
 */
export async function resolveSource() {
  const res = await fetch(PAGE_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`掲載ページの取得に失敗: HTTP ${res.status} ${PAGE_URL}`);
  const html = await res.text();

  const links = [...html.matchAll(/<a[^>]*href="([^"]*\.xlsx?)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: m[1],
    text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
  }));
  if (links.length !== 1) {
    throw new Error(
      `掲載ページのxlsxリンクが1本ではない（${links.length}本）。ページ構成が変わった可能性がある。\n` +
        links.map((l) => `  - ${l.href} : ${l.text}`).join('\n')
    );
  }
  const { href, text } = links[0];
  const url = new URL(href, PAGE_URL).toString();

  // ① リンク文言の和暦から日付を取る（例：医療用医薬品供給状況（令和８年８月14日現在））
  const m = toHalf(text).match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) throw new Error(`リンク文言から和暦の日付を読み取れない: "${text}"`);
  const asOfFromText = `${2018 + Number(m[1])}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;

  // ② ファイル名の数字から日付を取る（例：260814iyakuhinkyoukyu.xlsx → 2026-08-14。西暦の下2桁）
  const f = url.match(/\/(\d{2})(\d{2})(\d{2})iyakuhinkyoukyu\.xlsx$/i);
  const asOfFromName = f ? `20${f[1]}-${f[2]}-${f[3]}` : null;

  // ①と②が食い違うなら、どちらを信じてよいか分からないので止める
  if (asOfFromName && asOfFromName !== asOfFromText) {
    throw new Error(
      `版の日付が食い違う。リンク文言=${asOfFromText} / ファイル名=${asOfFromName}（${url}）。命名規則が変わった可能性がある`
    );
  }

  return { pageUrl: PAGE_URL, url, linkText: text, asOf: asOfFromText, asOfFromName };
}

/** xlsxを落とす。中身のハッシュも返す（前回と同じ版かの判定に使う） */
export async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`xlsxの取得に失敗: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100_000) throw new Error(`xlsxが小さすぎる（${buf.length}バイト）。取得に失敗している可能性がある`);
  return {
    buf,
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    lastModified: res.headers.get('last-modified') ?? null,
  };
}

/**
 * xlsxを読み、列構成を検証したうえで1行1オブジェクトに正規化する。
 * 検証に落ちたら例外。壊れたデータを保存して履歴を汚すより止める。
 */
export async function parseWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const ws = wb.worksheets.find((s) => s.name === SHEET_NAME) ?? wb.worksheets[0];
  if (ws.name !== SHEET_NAME) {
    throw new Error(`シート名が想定と違う。期待="${SHEET_NAME}" 実際="${wb.worksheets.map((s) => s.name).join('/')}"`);
  }

  // --- 列見出しの検証（空白・改行を除いて完全一致） ---
  const strip = (s) => clean(s).replace(/\s+/g, '');
  const headerRow = ws.getRow(HEADER_ROW);
  const mismatches = [];
  for (let i = 0; i < COLUMNS.length; i++) {
    const actual = strip(cellText(headerRow.getCell(i + 1).value));
    const expected = strip(COLUMNS[i].header);
    if (actual !== expected) mismatches.push(`  第${i + 1}列: 期待="${expected}"\n           実際="${actual}"`);
  }
  const extra = strip(cellText(headerRow.getCell(COLUMNS.length + 1).value));
  if (extra) mismatches.push(`  第${COLUMNS.length + 1}列に想定外の見出しがある: "${extra}"`);
  if (mismatches.length) {
    throw new Error(
      `列構成が変わっている（${mismatches.length}箇所）。scripts/lib/schema.mjs を実物に合わせて直すまで保存しない。\n` +
        mismatches.join('\n')
    );
  }

  // --- 本体 ---
  const rows = [];
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const o = {};
    let filled = 0;
    for (let i = 0; i < COLUMNS.length; i++) {
      const col = COLUMNS[i];
      const raw = row.getCell(i + 1).value;
      const v = col.kind === 'date' ? cellDate(raw) : clean(cellText(raw));
      o[col.key] = v;
      if (v !== '') filled++;
    }
    if (filled === 0) continue; // 完全な空行は捨てる
    rows.push(o);
  }

  const [lo, hi] = SANE_ROW_RANGE;
  if (rows.length < lo || rows.length > hi) {
    throw new Error(`行数が想定外（${rows.length}行）。期待は ${lo}〜${hi} 行。取得か解析が壊れている可能性がある`);
  }

  return rows;
}

/**
 * 主キー（YJコード）の健全性を確認する。
 * 空・重複があると差分が丸ごと信用できなくなるので、ここで止める（E-7）。
 */
export function checkKey(rows, key) {
  const empties = rows.filter((r) => !r[key]);
  if (empties.length) {
    throw new Error(`主キー ${key} が空の行が ${empties.length} 件ある。差分が取れないので止める`);
  }
  const seen = new Map();
  for (const r of rows) seen.set(r[key], (seen.get(r[key]) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  if (dups.length) {
    throw new Error(
      `主キー ${key} が重複している（${dups.length}種）。例: ` +
        dups.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ')
    );
  }
  // 12桁でないもの（実測では液化酸素などの未収載医薬品 X00000 形式が404件）は
  // 異常ではないので止めない。件数だけ返して記録に残す。
  const nonStandard = rows.filter((r) => !/^[0-9A-Z]{12}$/.test(r[key])).length;
  return { unique: seen.size, nonStandard };
}
