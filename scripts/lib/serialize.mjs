/**
 * data/*.json の書式。
 *
 * ★1行1レコードで書く。gitのdiffが「変わった品目の行だけ」になり、履歴が軽くなる。
 *   （厚労省は最新版1本しか置かないので、この履歴が唯一の過去データ＝共通ノウハウ F-7。
 *     毎日全行が書き換わる書式だと、リポジトリが短期間で膨れて使い物にならなくなる）
 */

/**
 * @param {object} header  先頭に置くメタ情報（asOf など）
 * @param {string[]} columns  列名の並び
 * @param {object[]} rows   レコード（オブジェクト）の配列
 * @param {(r:object)=>any[]} [pick]  行→配列の変換。省略時は columns をそのまま引く
 */
export function serializeRows(header, columns, rows, pick) {
  const head = Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const toArray = pick ?? ((r) => columns.map((c) => r[c]));
  const body = rows.map((r) => JSON.stringify(toArray(r))).join(',\n');
  // header が空でも壊れないよう、必ず columns から始める形に組み立てる
  const lines = [...head, `"columns": ${JSON.stringify(columns)}`, `"rows": [\n${body}\n]`];
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** 1行1レコード形式のファイルを読み戻す（列名→値のオブジェクト配列にする） */
export function deserializeRows(json) {
  const cols = json.columns;
  return json.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}
