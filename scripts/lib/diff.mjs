/**
 * 前回と今回を突き合わせて「何が変わったか」を出す。
 *
 * ここが本アプリの心臓なので、方針を明記しておく：
 *  - 変化の「事実」だけを出す。良くなった/悪くなった等の解釈はしない（医療情報の安全方針）。
 *  - 1品目1エントリにまとめる。同じ薬で3列変わっても通知は1件。
 *  - 初回（前回データが無い）は「全件が新規」ではなく「差分なし」として扱う。
 *    16,384件の追加通知を出しても意味がないため。
 */
import { COLUMNS, WATCHED } from './schema.mjs';

const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

/** 種別の重み。1品目で複数変わったときは重いほうを代表にする */
const RANK = { removed: 4, added: 3, shukka: 2, ryo: 1, detail: 0 };

/** 通知に出してよい変化か。理由・見込みだけの更新は通知しない（頻度が高くノイズになる） */
function isNotifiable(kind, row) {
  if (kind === 'shukka' || kind === 'removed') return true;
  // 新規掲載は「最初から通常出荷でない」ときだけ通知する
  if (kind === 'added') return !!row && row.shukka !== '' && !row.shukka.startsWith('①');
  return false;
}

/**
 * @param {Map<string,object>} prev  前回の全列レコード（キー→行）
 * @param {Map<string,object>} curr  今回の全列レコード
 */
export function buildChanges(prev, curr) {
  const changes = [];

  const identity = (r) => ({
    yj: r.yj,
    hinmei: r.hinmei,
    maker: r.maker,
    kikaku: r.kikaku,
    seibun: r.seibun,
  });

  for (const [yj, now] of curr) {
    const before = prev.get(yj);

    if (!before) {
      changes.push({
        ...identity(now),
        kind: 'added',
        shukka: now.shukka,
        ryo: now.ryo,
        fields: [],
        notify: isNotifiable('added', now),
      });
      continue;
    }

    const fields = [];
    let kind = null;
    for (const [group, keys] of Object.entries(WATCHED)) {
      for (const key of keys) {
        if (before[key] !== now[key]) {
          fields.push({ key, label: LABEL[key], from: before[key], to: now[key] });
          if (kind === null || RANK[group] > RANK[kind]) kind = group;
        }
      }
    }
    if (!fields.length) continue;

    changes.push({
      ...identity(now),
      kind,
      shukka: now.shukka,
      ryo: now.ryo,
      fields,
      notify: isNotifiable(kind, now),
    });
  }

  for (const [yj, before] of prev) {
    if (curr.has(yj)) continue;
    changes.push({
      ...identity(before),
      kind: 'removed',
      shukka: before.shukka,
      ryo: before.ryo,
      fields: [],
      notify: true,
    });
  }

  // 重い順 → YJ順。並び順を固定しないと、中身が同じでも毎回diffが出てしまう
  changes.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.yj.localeCompare(b.yj));

  const summary = { total: changes.length, notify: 0, added: 0, removed: 0, shukka: 0, ryo: 0, detail: 0 };
  for (const c of changes) {
    summary[c.kind]++;
    if (c.notify) summary.notify++;
  }
  return { changes, summary };
}

/** 出荷対応の分布（画面のサマリ表示と、異常検知の材料に使う） */
export function tally(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}
