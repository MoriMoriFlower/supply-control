/**
 * 前回と今回を突き合わせて「何が変わったか」を出す。
 *
 * ここが本アプリの心臓なので、方針を明記しておく：
 *  - 変化の「事実」だけを出す。良くなった/悪くなった等の解釈はしない（医療情報の安全方針）。
 *  - 1品目1エントリにまとめる。同じ薬で3列変わっても通知は1件。
 *  - 初回（前回データが無い）は「全件が新規」ではなく「差分なし」として扱う。
 *    16,384件の追加通知を出しても意味がないため。
 */
import { COLUMNS, WATCHED, RYO_NORMAL } from './schema.mjs';

const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

/** 種別の重み。1品目で複数変わったときは重いほうを代表にする */
const RANK = { removed: 4, added: 3, shukka: 2, ryo: 1, detail: 0 };

/** ⑫が「①通常出荷」か。空欄は未報告なので通常扱い（＝それだけでは通知しない） */
const shukkaIsNormal = (v) => (v ?? '') === '' || v.startsWith('①');

/**
 * ⑰出荷量を「通知の単位」に畳む。
 *
 * A．通常 と Aプラス．増加 だけを同じ扱いにし（現場から見ればどちらも発注すれば入る）、
 * B．減少 / C．出荷停止 / D．薬価削除予定 は**それぞれ別物**として扱う。
 * つまり B→C（減っている → 止まった）も B→D（減っている → いずれ無くなる）も通知する。
 *
 * 空欄は「未報告」であって異常ではないので普通側。
 * 知らない値はそれ自体が1つの区分になるので、普通↔知らない値の移動は必ず通知される。
 */
const ryoGroup = (v) => {
  const s = v ?? '';
  return s === '' || RYO_NORMAL.has(s) ? '普通' : s;
};

/** ⑰が「普通に入ってくる」側か */
const ryoIsNormal = (v) => ryoGroup(v) === '普通';

/**
 * 通知に出してよい変化か。
 *
 *  - ⑫出荷対応の変化・掲載終了 …… 必ず通知
 *  - ⑰出荷量の変化 …… A⇄Aプラス以外は通知する（悪化も回復も同じ扱い。事実だけを伝える方針）。
 *    ★★これが無いと現場で一番効く層が丸ごと沈黙する。
 *      ⑫が「①通常出荷」のまま⑰だけBに落ちている品目が実測827件あり（CLAUDE.md §3のクロス集計）、
 *      2026-08-17に実際そうなった（ユナスピン静注用1.5g：⑫①のまま A→B。旧実装では通知0件）。
 *    ★A⇄Aプラスだけを黙らせる。実測 2026-08-17 は⑰の変化8件中5件がこれで、
 *      現場では何も起きないのでノイズにしかならない。
 *  - 新規掲載 …… 最初から⑫が通常でない、または⑰が普通でないときだけ通知
 *  - ⑭理由・⑮⑯見込みだけの更新 …… 通知しない（頻度が高くノイズになる）
 *
 * @param {string} kind   変化の種別
 * @param {object} row    今回の行（removed のときは前回の行）
 * @param {Array}  fields 変化した列の from/to
 */
function isNotifiable(kind, row, fields = []) {
  if (kind === 'shukka' || kind === 'removed') return true;
  if (kind === 'added') return !!row && (!shukkaIsNormal(row.shukka) || !ryoIsNormal(row.ryo));
  if (kind === 'ryo') {
    const f = fields.find((x) => x.key === 'ryo');
    return !!f && ryoGroup(f.from) !== ryoGroup(f.to);
  }
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
      notify: isNotifiable(kind, now, fields),
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
