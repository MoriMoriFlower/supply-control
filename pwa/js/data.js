/**
 * 配布物（data/）の読み込み。
 *
 * 毎日変わるのは status-lite.json（生350KB / brotli 42KB）と changes/latest.json だけ。
 * search.json（生2.2MB）は品目の素性なので、新規収載か掲載終了があった日しか変わらない。
 * そこで meta.json に書いてあるハッシュを見て、変わっていなければ端末の控えを使う。
 * 結果、ふだんの起動は数十KBの通信で済む。
 *
 * ★取得はすべて GET のみ。こちらから送る情報は無い（気になる薬リストは端末から出さない）。
 */
import { getBlob, putBlob } from './db.js';

const BASE = 'data/';

async function fetchText(name, { fresh = false } = {}) {
  const res = await fetch(BASE + name, fresh ? { cache: 'no-cache' } : {});
  if (!res.ok) throw new Error(`${name} を取得できない（HTTP ${res.status}）`);
  return res.text();
}

/** 版と各ファイルの指紋。小さいので毎回取り直す */
export async function loadMeta() {
  return JSON.parse(await fetchText('meta.json', { fresh: true }));
}

/** ハッシュが一致すれば端末の控えを使う。違えば取り直して控えを更新する */
async function loadCached(name, sha256) {
  if (sha256) {
    const hit = await getBlob(name, sha256);
    if (hit) {
      try {
        return { json: JSON.parse(hit), fromCache: true };
      } catch {
        /* 壊れていたら取り直す */
      }
    }
  }
  const text = await fetchText(name);
  const json = JSON.parse(text);
  if (sha256) await putBlob(name, sha256, text);
  return { json, fromCache: false };
}

/** 1行1レコード形式 → オブジェクトの配列 */
function rowsOf(json) {
  return json.rows.map((r) => Object.fromEntries(json.columns.map((c, i) => [c, r[i]])));
}

/** 品目の素性。検索の対象になる */
export async function loadSearch(meta) {
  const { json, fromCache } = await loadCached('search.json', meta.index?.['search.json']?.sha256);
  return { rows: rowsOf(json), fromCache };
}

/**
 * 今の出荷対応・出荷量。値はコードなので、ファイル先頭の一覧で文字列に戻す。
 * @returns {Map<string,{shukka:string,ryo:string}>}
 */
export async function loadStatus(meta) {
  const { json } = await loadCached('status-lite.json', meta.index?.['status-lite.json']?.sha256);
  const map = new Map();
  for (const [yj, s, r] of json.rows) {
    map.set(yj, { shukka: json.shukkaValues[s] ?? '', ryo: json.ryoValues[r] ?? '' });
  }
  return map;
}

/** 直近の版で変化したもの */
export async function loadChanges() {
  return JSON.parse(await fetchText('changes/latest.json', { fresh: true }));
}
