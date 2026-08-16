/**
 * 差分ロジックの自己テスト。外部アクセスなしで動く。
 * 保存済みの data/ を土台に、わざと変化を作って検出できるか確かめる。
 *
 * 「差分0件」は正常にも故障にも見えるので、必ず“出るはずのものが出る”ことを確認する（共通ノウハウ E-13）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildChanges } from './lib/diff.mjs';
import { KEY } from './lib/schema.mjs';

const DATA = path.resolve('data');
const load = async (f) => {
  const j = JSON.parse(await readFile(path.join(DATA, f), 'utf8'));
  return new Map(j.rows.map((r) => [r[j.columns.indexOf(KEY)], Object.fromEntries(j.columns.map((c, i) => [c, r[i]]))]));
};

const items = await load('items.json');
const status = await load('status.json');
const base = new Map();
for (const [yj, it] of items) base.set(yj, { ...it, ...(status.get(yj) ?? {}) });
console.log(`土台: ${base.size.toLocaleString()} 品目`);

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  ★NG  ${name} ${detail}`); }
};

const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
const pick = (fn, n = 1) => [...base.values()].filter(fn).slice(0, n);

// --- ① まったく同じなら0件（ここが0件でないと、以降のテストが全部無意味になる） ---
{
  const { summary } = buildChanges(base, clone(base));
  check('同一データの差分は0件', summary.total === 0, `→ ${summary.total}件出た`);
}

// --- ② ⑫出荷対応が変わったら検出し、通知対象になる ---
{
  const curr = clone(base);
  const [target] = pick((r) => r.shukka === '①通常出荷');
  curr.get(target.yj).shukka = '②限定出荷（自社の事情）';
  const { changes, summary } = buildChanges(base, curr);
  check('出荷対応の変化を1件検出', summary.total === 1 && summary.shukka === 1, JSON.stringify(summary));
  check('出荷対応の変化は通知対象', changes[0]?.notify === true);
  check('変化前後の値を両方持つ',
    changes[0]?.fields[0]?.from === '①通常出荷' && changes[0]?.fields[0]?.to === '②限定出荷（自社の事情）',
    JSON.stringify(changes[0]?.fields));
  check('品名・製造販売業者を同梱（通知が単体で成立する）', !!changes[0]?.hinmei && !!changes[0]?.maker);
}

// --- ③ 供給停止への変化と、通常出荷への回復。どちらも「事実」として同じ扱いで出る ---
{
  const curr = clone(base);
  const [a] = pick((r) => r.shukka === '①通常出荷');
  const [b] = pick((r) => r.shukka === '⑤供給停止');
  curr.get(a.yj).shukka = '⑤供給停止';
  curr.get(b.yj).shukka = '①通常出荷';
  const { summary } = buildChanges(base, curr);
  check('悪化と回復を両方とも検出', summary.shukka === 2, JSON.stringify(summary));
}

// --- ④ ⑭理由だけの更新は検出するが通知対象にしない ---
{
  const curr = clone(base);
  const [target] = pick((r) => r.riyu === '７．－');
  curr.get(target.yj).riyu = '１．需要増';
  const { changes, summary } = buildChanges(base, curr);
  check('理由の変化を検出', summary.detail === 1, JSON.stringify(summary));
  check('理由だけの変化は通知しない', changes[0]?.notify === false);
}

// --- ⑤ 1品目で3列変わっても1エントリにまとまる ---
{
  const curr = clone(base);
  const [target] = pick((r) => r.shukka === '①通常出荷');
  const t = curr.get(target.yj);
  t.shukka = '⑤供給停止';
  t.ryo = 'C．出荷停止';
  t.riyu = '３．製造トラブル（製造委託を含む）';
  const { changes, summary } = buildChanges(base, curr);
  check('3列変わっても1件にまとまる', summary.total === 1, `→ ${summary.total}件`);
  check('変化した3列を全部保持', changes[0]?.fields.length === 3, JSON.stringify(changes[0]?.fields?.map((f) => f.key)));
  check('代表の種別は重いほう（出荷対応）', changes[0]?.kind === 'shukka', changes[0]?.kind);
}

// --- ⑥ 新規掲載・掲載終了 ---
{
  const curr = clone(base);
  const [gone] = pick((r) => r.shukka === '①通常出荷');
  curr.delete(gone.yj);
  const [seed] = pick((r) => r.shukka === '⑤供給停止');
  curr.set('ZZZZ99999999', { ...seed, yj: 'ZZZZ99999999', hinmei: 'テスト新規品' });
  const { changes, summary } = buildChanges(base, curr);
  check('掲載終了を検出', summary.removed === 1, JSON.stringify(summary));
  check('新規掲載を検出', summary.added === 1, JSON.stringify(summary));
  check('掲載終了は通知対象', changes.find((c) => c.kind === 'removed')?.notify === true);
  check('供給停止での新規掲載は通知対象', changes.find((c) => c.kind === 'added')?.notify === true);
}

// --- ⑦ 通常出荷での新規掲載は通知しない（ノイズになるため） ---
{
  const curr = clone(base);
  const [seed] = pick((r) => r.shukka === '①通常出荷');
  curr.set('ZZZZ88888888', { ...seed, yj: 'ZZZZ88888888', hinmei: 'テスト通常新規' });
  const { changes } = buildChanges(base, curr);
  check('通常出荷の新規掲載は通知しない', changes.find((c) => c.kind === 'added')?.notify === false);
}

// --- ⑧ 並び順が安定している（同じ入力で毎回同じ出力＝無駄なコミットを生まない） ---
{
  const curr = clone(base);
  for (const r of pick((r) => r.shukka === '①通常出荷', 5)) curr.get(r.yj).shukka = '⑤供給停止';
  const a = JSON.stringify(buildChanges(base, curr).changes);
  const b = JSON.stringify(buildChanges(base, new Map([...curr].reverse())).changes);
  check('入力順が変わっても出力は同一', a === b);
}

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
