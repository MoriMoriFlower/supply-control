/**
 * 厚労省「医療用医薬品供給状況」xlsx の列定義。
 *
 * ★ここは原本の写しである。列見出しは厚労省の原文を逐語で保持し、
 *   毎回の取得時に実ファイルと突き合わせる（expectedHeader）。
 *   1文字でも違えば collect.mjs が例外で止まる。
 *   「列が入れ替わったのに気付かないまま別の列を保存し続ける」のが最悪なので、
 *   黙って動き続けるより止まるほうを選ぶ。
 */

/** シート名（原本どおり） */
export const SHEET_NAME = '供給状況一覧表';

/** ヘッダー行 / データ開始行（1始まり） */
export const HEADER_ROW = 2;
export const FIRST_DATA_ROW = 3;

/**
 * 列定義。順序が原本の列順そのもの。
 * - key       : JSONで使う短い名前
 * - header    : 原本の見出し（改行・空白を除いて比較する）
 * - group     : 'item'   = 品目の素性（ほぼ変わらない）→ items.json へ
 *               'status' = 供給状況（毎日変わりうる）  → status.json へ
 * - kind      : 'text' | 'date'（date はExcelのシリアル値をISO日付へ変換する）
 * - label     : 画面表示用の短い日本語
 */
export const COLUMNS = [
  { key: 'kubun',         header: '①薬剤区分',                        group: 'item',   kind: 'text', label: '薬剤区分' },
  { key: 'yakko',         header: '②薬効分類（保険薬収載時点の薬効分類を記載）', group: 'item', kind: 'text', label: '薬効分類' },
  { key: 'seibun',        header: '③成分名',                          group: 'item',   kind: 'text', label: '成分名' },
  { key: 'kikaku',        header: '④規格単位※全角',                    group: 'item',   kind: 'text', label: '規格単位' },
  { key: 'yj',            header: '⑤YJコード',                        group: 'item',   kind: 'text', label: 'YJコード' },
  { key: 'hinmei',        header: '⑥品名（承認書に記載の正式名称）※全角',  group: 'item',   kind: 'text', label: '品名' },
  { key: 'maker',         header: '⑦製造販売業者名',                    group: 'item',   kind: 'text', label: '製造販売業者' },
  { key: 'seihinKubun',   header: '⑧製品区分',                        group: 'item',   kind: 'text', label: '製品区分' },
  { key: 'kisoteki',      header: '⑨基礎的医薬品',                      group: 'item',   kind: 'text', label: '基礎的医薬品' },
  { key: 'kakuho',        header: '⑩（重要）供給確保医薬品',              group: 'item',   kind: 'text', label: '供給確保医薬品' },
  { key: 'yakkaDate',     header: '⑪薬価収載年月日',                    group: 'item',   kind: 'date', label: '薬価収載年月日' },

  { key: 'shukka',        header: '⑫製造販売業者の「出荷対応」の状況',      group: 'status', kind: 'text', label: '出荷対応の状況' },
  { key: 'shukkaUpdated', header: '⑬当該品目の⑫の情報を更新した日（本項目を報告内容として追加した令和7年5月13日以降に⑫の情報を更新した品目についてのみ記載）', group: 'status', kind: 'date', label: '出荷対応の更新日' },
  { key: 'riyu',          header: '⑭限定出荷/供給停止の理由',             group: 'status', kind: 'text', label: '理由' },
  { key: 'kaijo',         header: '⑮限定出荷の解除見込み／供給停止の解消見込み', group: 'status', kind: 'text', label: '解除・解消見込み' },
  { key: 'shoujin',       header: '⑯限定出荷の解除見込み／供給停止の解消見込み／販売中止品の在庫消尽時期', group: 'status', kind: 'text', label: '見込み時期・在庫消尽時期' },
  { key: 'ryo',           header: '⑰製造販売業者の「出荷量」の現在の状況',   group: 'status', kind: 'text', label: '出荷量の状況' },
  { key: 'kaizenJiki',    header: '⑱製造販売業者の「出荷量」の改善（増加）見込み時期', group: 'status', kind: 'text', label: '出荷量の改善見込み時期' },
  { key: 'kaizenRyo',     header: '⑲⑱を任意選択した場合の「出荷量」の改善（増加）見込み量', group: 'status', kind: 'text', label: '出荷量の改善見込み量' },
  { key: 'otherUpdated',  header: '⑳当該品目の⑫以外の情報を更新した日',      group: 'status', kind: 'date', label: 'その他情報の更新日' },
  { key: 'isNew',         header: '今回掲載時の更新有無（更新有りの場合、Newと表示）', group: 'status', kind: 'text', label: '新規掲載' },
];

/** 主キー。実測で 16,384件すべて非空・重複なし（2026-08-16 / 令和8年8月14日版） */
export const KEY = 'yj';

export const ITEM_KEYS = COLUMNS.filter((c) => c.group === 'item').map((c) => c.key);
/** status.json にも主キーを含める（items.json と突き合わせるため） */
export const STATUS_KEYS = [KEY, ...COLUMNS.filter((c) => c.group === 'status').map((c) => c.key)];

/**
 * 差分の種別。通知に出すのは 'added' / 'removed' / 'shukka' / 'ryo' まで。
 * 'detail' は理由・見込みの更新で、画面には出すが通知本文には出さない。
 */
export const WATCHED = {
  shukka: ['shukka'],
  ryo: ['ryo'],
  detail: ['riyu', 'kaijo', 'shoujin', 'kaizenJiki', 'kaizenRyo'],
};

/** 想定される行数の範囲。ここを外れたら取得か解析が壊れているとみなして止める */
export const SANE_ROW_RANGE = [10000, 40000];
