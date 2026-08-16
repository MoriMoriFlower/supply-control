/**
 * 端末内の保存庫（IndexedDB）。
 *
 * ★ここに入るもの（気になる薬リスト）は、絶対にサーバーへ送らない。
 *   採用薬に近い情報は勤務先の調達情報にあたるため（SupplyControl/CLAUDE.md 2節・共通ノウハウ I-1）。
 *   サーバーが預かってよいのはプッシュ購読情報（匿名文字列）だけ。
 *
 * ★localStorage ではなく IndexedDB を使う理由：
 *   通知を組み立てるのは Service Worker で、SW からは同期APIの localStorage を読めない。
 *   画面と SW が同じ場所を見る必要があるので、最初から IndexedDB に置く（共通ノウハウ C-6）。
 */

const DB_NAME = 'supply-control';
const DB_VERSION = 1;

/** 気になる薬。keyPath は YJコード */
export const WATCH = 'watch';
/** 大きい配布物の控え。ハッシュが変わるまで取り直さないためのもの */
export const BLOB = 'blob';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WATCH)) db.createObjectStore(WATCH, { keyPath: 'yj' });
      if (!db.objectStoreNames.contains(BLOB)) db.createObjectStore(BLOB, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve();
    }
  });
}

/* --- 気になる薬 --- */

/**
 * 品名などを一緒に保存しておく。
 * search.json をまだ読めていなくても一覧を描けるようにするため。
 */
export function addWatch(row) {
  return run(WATCH, 'readwrite', (s) =>
    s.put({
      yj: row.yj,
      hinmei: row.hinmei,
      seibun: row.seibun,
      maker: row.maker,
      kikaku: row.kikaku,
      addedAt: new Date().toISOString(),
    })
  );
}

export function removeWatch(yj) {
  return run(WATCH, 'readwrite', (s) => s.delete(yj));
}

export async function listWatch() {
  const rows = await run(WATCH, 'readonly', (s) => s.getAll());
  return (rows ?? []).sort((a, b) => (a.hinmei ?? '').localeCompare(b.hinmei ?? '', 'ja'));
}

/* --- 配布物の控え --- */

export async function getBlob(name, sha256) {
  try {
    const hit = await run(BLOB, 'readonly', (s) => s.get(name));
    return hit && hit.sha256 === sha256 ? hit.text : null;
  } catch {
    return null; // 控えが壊れていても取得し直せばよいだけなので握り潰す
  }
}

export async function putBlob(name, sha256, text) {
  try {
    await run(BLOB, 'readwrite', (s) => s.put({ name, sha256, text }));
  } catch {
    /* 容量不足などで保存できなくても動作に支障はない */
  }
}
