/**
 * 薬の名前を「検索用の形」に均す。
 *
 * 厚労省の原本は全角で書かれている：
 *   品名   「ラボナール注射用０．３ｇ」
 *   規格   「３００ｍｇ１管」
 *   成分名 「チオペンタールナトリウム」
 * 一方で人が打つのは「ラボナール 0.3g」「らぼなーる」「チオペンタール」など。
 * そのままでは当たらないので、両方を同じ形に潰してから部分一致する。
 *
 * ★ここで潰すのは検索キーだけで、画面に出す文字列は原本のまま使う。
 *   医療情報を勝手に書き換えて表示しない（薬剤師/CLAUDE.md 2節）。
 *
 * ブラウザからも Node（自己テスト）からも import できるよう、素のESMで書く。
 */

/** 検索の邪魔にしかならない記号・区切り。原本にも入力にも現れうるので両方から落とす */
const NOISE = /[\s　・･ー‐−–—〜~/／\\＼()（）[\]「」『』{}｛｝、。,.:：;；'"’“”%％&＆+＋*＊#＃!！?？|｜_＿=＝<>＜＞@＠^￥$＄]/g;

/** 小書きかな → 大書き。「シャ」と「シヤ」の揺れを吸収する */
const SMALL = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', っ: 'つ', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ', ゕ: 'か', ゖ: 'け' };

/**
 * @param {string} s
 * @returns {string} 比較用のキー。表示には使わない
 */
export function normalize(s) {
  if (!s) return '';

  // 1. NFKC：全角英数記号→半角、半角カナ→全角カナ、濁点の合成まで一度に片づく
  //    「ラボナール注射用０．３ｇ」→「ラボナール注射用0.3g」
  let t = s.normalize('NFKC').toLowerCase();

  // 2. カタカナ→ひらがな。打った側がどちらでも当たるように片方へ寄せる
  //    ヴ(30F4)・ヵヶ(30F5,30F6)まで含む。ヽヾ(30FD,30FE)は対象外
  t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // 3. 小書きかなを大書きへ
  t = t.replace(/[ぁぃぅぇぉっゃゅょゎゕゖ]/g, (c) => SMALL[c]);

  // 4. 記号・空白・長音を落とす
  return t.replace(NOISE, '');
}

/** 項目の区切り。normalize() が必ず消す文字なので、検索語には絶対に現れない */
const SEP = '|';

/**
 * 1品目を検索対象の1本の文字列にする。
 * 品名・成分名・製造販売業者・規格・YJコードのどれで打っても当たるようにする。
 *
 * 区切りに SEP を挟むのは、「品名の末尾＋成分名の先頭」にまたがった
 * 誤ヒットを防ぐため。SEP は NOISE に含まれるので検索語側には現れない。
 */
export function haystack(row) {
  return [row.hinmei, row.seibun, row.maker, row.kikaku, row.yj].map(normalize).join(SEP);
}

/**
 * 入力を検索語に割る。空白区切りの語を「すべて含む」ものを当たりとする（AND）。
 * 「ロキソ 錠」のように足して絞り込めるようにするため。
 */
export function terms(query) {
  return (query ?? '')
    .split(/[\s　]+/)
    .map(normalize)
    .filter(Boolean);
}

/** haystack が words をすべて含むか */
export function matches(hay, words) {
  for (const w of words) if (!hay.includes(w)) return false;
  return true;
}
