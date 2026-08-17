/**
 * 差分ロジックの自己テスト。外部アクセスなしで動く。
 * 保存済みの data/ を土台に、わざと変化を作って検出できるか確かめる。
 *
 * 「差分0件」は正常にも故障にも見えるので、必ず“出るはずのものが出る”ことを確認する（共通ノウハウ E-13）。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildChanges, isNotifiable } from './lib/diff.mjs';
import { judge, addDays, COUNT_TOLERANCE } from './lib/canary.mjs';
import { KEY } from './lib/schema.mjs';
import { normalize, haystack, terms, matches } from '../pwa/js/normalize.js';

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
  const [seed] = pick((r) => r.shukka === '①通常出荷' && r.ryo === 'A．出荷量通常');
  curr.set('ZZZZ88888888', { ...seed, yj: 'ZZZZ88888888', hinmei: 'テスト通常新規' });
  const { changes } = buildChanges(base, curr);
  check('通常出荷の新規掲載は通知しない', changes.find((c) => c.kind === 'added')?.notify === false);
}
{
  const curr = clone(base);
  const [seed] = pick((r) => r.shukka === '①通常出荷' && r.ryo === 'B．出荷量減少');
  curr.set('ZZZZ77777777', { ...seed, yj: 'ZZZZ77777777', hinmei: 'テスト減少新規' });
  const { changes } = buildChanges(base, curr);
  check('①通常出荷でも出荷量減少での新規掲載は通知対象', changes.find((c) => c.kind === 'added')?.notify === true);
}

// --- ⑧ ⑰出荷量。★ここが本アプリの肝 ---
//     ⑫が「①通常出荷」のまま⑰だけBに落ちる品目が実測827件ある。
//     2026-08-17に実際そうなった（ユナスピン静注用1.5g：⑫①のまま A→B）が、
//     当時の実装は kind==='ryo' を一律 notify:false にしていたため通知0件だった。
//     この節が落ちたら、その沈黙が戻ったということ。
{
  const curr = clone(base);
  const [a] = pick((r) => r.shukka === '①通常出荷' && r.ryo === 'A．出荷量通常');
  curr.get(a.yj).ryo = 'B．出荷量減少';
  const { changes, summary } = buildChanges(base, curr);
  check('①通常出荷のまま出荷量A→Bを検出', summary.ryo === 1, JSON.stringify(summary));
  check('★①通常出荷のまま出荷量A→Bは通知対象', changes[0]?.notify === true);
  check('⑫は変わっていない（⑰だけの変化）', changes[0]?.fields.every((f) => f.key === 'ryo'));
}
{
  const curr = clone(base);
  const [a] = pick((r) => r.ryo === 'B．出荷量減少');
  curr.get(a.yj).ryo = 'A．出荷量通常';
  const { changes } = buildChanges(base, curr);
  check('出荷量の回復(B→A)も通知対象', changes[0]?.notify === true);
}
{
  const curr = clone(base);
  const [a] = pick((r) => r.ryo === 'A．出荷量通常');
  const [b] = pick((r) => r.ryo === 'Aプラス．出荷量増加');
  curr.get(a.yj).ryo = 'Aプラス．出荷量増加';
  curr.get(b.yj).ryo = 'A．出荷量通常';
  const { changes, summary } = buildChanges(base, curr);
  check('A⇄Aプラスも変化としては検出する（画面には出す）', summary.ryo === 2, JSON.stringify(summary));
  check('A⇄Aプラスは通知しない（ノイズ）', changes.every((c) => c.notify === false));
}
{
  // B/C/D はそれぞれ別物。異常どうしの移動も通知する。
  // ★B．減少 → C．出荷停止（減っている → 止まった）を黙るのは、827件の沈黙と同じ性質のミス
  const curr = clone(base);
  const [a] = pick((r) => r.ryo === 'B．出荷量減少');
  const [b] = pick((r) => r.ryo === 'D．薬価削除予定');
  curr.get(a.yj).ryo = 'C．出荷停止';
  curr.get(b.yj).ryo = 'B．出荷量減少';
  const { changes, summary } = buildChanges(base, curr);
  check('★異常どうしの移動(B→C)も通知対象', summary.ryo === 2 && changes.every((c) => c.notify === true),
    JSON.stringify(changes.map((c) => [c.fields[0]?.from, c.fields[0]?.to, c.notify])));
}
{
  const curr = clone(base);
  const [a] = pick((r) => r.ryo === 'B．出荷量減少');
  curr.get(a.yj).ryo = 'D．薬価削除予定';
  const { changes } = buildChanges(base, curr);
  check('B→D（いずれ無くなる）も通知対象', changes[0]?.notify === true);
}
{
  // ⑫と⑰が同時に動いたら、代表は重いほう（⑫）になり、通知対象であることは変わらない
  const curr = clone(base);
  const [a] = pick((r) => r.shukka === '①通常出荷' && r.ryo === 'A．出荷量通常');
  curr.get(a.yj).shukka = '⑤供給停止';
  curr.get(a.yj).ryo = 'C．出荷停止';
  const { changes } = buildChanges(base, curr);
  check('⑫と⑰が同時に動いても通知対象', changes[0]?.kind === 'shukka' && changes[0]?.notify === true);
}

// --- ⑨ 並び順が安定している（同じ入力で毎回同じ出力＝無駄なコミットを生まない） ---
{
  const curr = clone(base);
  for (const r of pick((r) => r.shukka === '①通常出荷', 5)) curr.get(r.yj).shukka = '⑤供給停止';
  const a = JSON.stringify(buildChanges(base, curr).changes);
  const b = JSON.stringify(buildChanges(base, new Map([...curr].reverse())).changes);
  check('入力順が変わっても出力は同一', a === b);
}

// --- ⑨ ソースに不可視文字が紛れ込んでいない ---
// 実際に normalize.js へ U+0001 が2つ混入した（2026-08-16）。目視では絶対に分からないので機械で見張る。
// 不可視文字はエスケープ表記でしか書かない、という掟（共通ノウハウ E-7）の自動化。
{
  const dirs = ['scripts', 'pwa'];
  const bad = [];
  for (const d of dirs) {
    let names;
    try {
      names = await readdir(path.resolve(d), { recursive: true });
    } catch {
      continue; // まだ無いディレクトリは飛ばす
    }
    for (const n of names) {
      if (!/\.(mjs|js|json|html|css|webmanifest)$/.test(n)) continue;
      const file = path.join(path.resolve(d), n);
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue; // ディレクトリ
      }
      [...text].forEach((c, i) => {
        const n2 = c.codePointAt(0);
        const invisible =
          (n2 < 0x20 && c !== '\n' && c !== '\r' && c !== '\t') ||
          n2 === 0x7f ||
          (n2 >= 0x200b && n2 <= 0x200f) ||
          n2 === 0x2060 ||
          n2 === 0xfeff;
        if (invisible) bad.push(`${d}/${n} の ${i} 文字目に U+${n2.toString(16).toUpperCase().padStart(4, '0')}`);
      });
    }
  }
  check('ソースに不可視文字が無い', bad.length === 0, bad.slice(0, 5).join(' / '));
}

// --- ⑩ 検索の正規化。全角の原本と、人が打つ半角・かなを同じ形に潰せているか ---
{
  check('全角英数を半角に', normalize('０．３ｇ') === normalize('0.3g'), normalize('０．３ｇ'));
  // 「ラボナール 0.3g」は語に割れて AND で当たる（間に「注射用」が挟まっていても拾える）
  check(
    '全角の原本を半角の入力で拾える',
    matches(normalize('ラボナール注射用０．３ｇ'), terms('ラボナール 0.3g')),
    `${normalize('ラボナール注射用０．３ｇ')} ← ${JSON.stringify(terms('ラボナール 0.3g'))}`
  );
  check('カタカナとひらがなが同じ', normalize('ロキソニン') === normalize('ろきそにん'));
  check('半角カナも同じ', normalize('ﾑｺﾀﾞｲﾝ') === normalize('ムコダイン'));
  check('小書きの揺れを吸収', normalize('シャープ') === normalize('シヤープ'));
  check('空の入力は空', normalize('') === '' && normalize(undefined) === '');
  check('検索語に区切り記号は残らない', !terms('ロキソ|ニン').some((t) => t.includes('|')), JSON.stringify(terms('ロキソ|ニン')));

  // 項目をまたいだ誤ヒットが起きないこと（品名の末尾＋成分名の先頭で当たらない）
  const hay = haystack({ hinmei: 'アイウ', seibun: 'エオカ', maker: '', kikaku: '', yj: '' });
  check('項目をまたいでは当たらない', !matches(hay, terms('ウエ')), hay);
  check('項目の中では当たる', matches(hay, terms('イウ')) && matches(hay, terms('エオ')));
}

// --- ⑪ 実データで引けるか（索引が正しく作られていることの確認も兼ねる） ---
{
  const j = JSON.parse(await readFile(path.join(DATA, 'search.json'), 'utf8'));
  const rows = j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c, r[i]])));
  const hays = rows.map(haystack);
  const find = (q) => {
    const w = terms(q);
    return rows.filter((_, i) => matches(hays[i], w));
  };

  check('search.json の件数が items.json と一致', rows.length === base.size, `${rows.length} / ${base.size}`);
  check('YJ順に並んでいる', rows.every((r, i) => i === 0 || rows[i - 1].yj <= r.yj));

  const sample = [...base.values()][0];
  check('YJコード完全一致で1件だけ引ける', find(sample.yj).length === 1, sample.yj);
  check('ひらがなで打っても引ける', find('らぼなーる').some((r) => r.hinmei.includes('ラボナール')));
  check('成分名でも引ける', find('ロキソプロフェン').length > 1);
  check('存在しない語では0件', find('ぜったいにないくすりのなまえ').length === 0);
}

// --- ⑫ status-lite.json のコード表が実データと矛盾しない ---
{
  const lite = JSON.parse(await readFile(path.join(DATA, 'status-lite.json'), 'utf8'));
  const map = new Map(lite.rows.map((r) => [r[0], r]));
  check('status-lite の件数が一致', map.size === base.size, `${map.size} / ${base.size}`);

  let ok = 0;
  let ng = [];
  for (const [yj, r] of base) {
    const row = map.get(yj);
    if (!row) { ng.push(`${yj} が無い`); continue; }
    if (lite.shukkaValues[row[1]] !== r.shukka) ng.push(`${yj} の出荷対応: ${lite.shukkaValues[row[1]]} ≠ ${r.shukka}`);
    else if (lite.ryoValues[row[2]] !== r.ryo) ng.push(`${yj} の出荷量: ${lite.ryoValues[row[2]]} ≠ ${r.ryo}`);
    else ok++;
  }
  check(`コードを戻すと原本と一致（${ok.toLocaleString()}件）`, ng.length === 0, ng.slice(0, 3).join(' / '));
}

// --- ⑬ 保存済みの通知フラグが、いまの判定と一致しているか ---
//
// ★これが今回の穴。notify は collect が走った瞬間の判定を焼き付けたもので、
//   あとから判定を直しても、元ファイルが変わらない日は collect が早期終了するため
//   保存済みのファイルは古い判定のまま残る。
//   実際に 2026-08-17 の記録が notify=0 のまま取り残された（ユナスピンが沈黙していた）。
//   ここが落ちたら `npm run recompute` を実行すること。
{
  const dir = path.join(DATA, 'changes');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const stale = [];
  let checked = 0;

  for (const f of files) {
    const doc = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    for (const c of doc.changes ?? []) {
      checked++;
      const now = isNotifiable(c.kind, { shukka: c.shukka, ryo: c.ryo }, c.fields ?? []);
      if (now !== c.notify) stale.push(`${f}: ${c.hinmei}（記録 ${c.notify} / いまの判定 ${now}）`);
    }
    const n = (doc.changes ?? []).filter((c) => c.notify).length;
    if (doc.summary && doc.summary.notify !== n) stale.push(`${f}: summary.notify が ${doc.summary.notify}（実際は ${n}）`);
  }

  check(
    `保存済みの通知フラグがいまの判定と一致（${files.length}ファイル / ${checked.toLocaleString()}件）`,
    stale.length === 0,
    stale.slice(0, 3).join(' / ') + (stale.length ? ' → npm run recompute で直る' : '')
  );
}

// --- ⑭ カナリアの判定（ネットワークを触らない純粋関数だけを試す） ---
//
// カナリアは「厚労省xlsxが静かに止まったこと」に気付くための唯一の仕掛けなので、
// 鳴るべきときに鳴り、鳴るべきでないときに黙ることを機械で確かめておく。
{
  check('addDays: 月をまたぐ', addDays('2026-08-31', 1) === '2026-09-01', addDays('2026-08-31', 1));
  check('addDays: 年をまたぐ', addDays('2026-12-28', 8) === '2027-01-05', addDays('2026-12-28', 8));
  check('addDays: うるう年の2月', addDays('2028-02-28', 1) === '2028-02-29', addDays('2028-02-28', 1));

  const ok = { asOf: '2026-08-17', rows: 16385, apiTotal: 16385, staleCount: 0, staleFrom: '2026-08-25' };
  check('正常なら鳴らない', judge(ok).length === 0, JSON.stringify(judge(ok)));

  check('件数の小さな差では鳴らない（両者の更新時刻はずれる）',
    judge({ ...ok, apiTotal: 16385 + COUNT_TOLERANCE }).length === 0);
  check('件数が大きく乖離したら鳴る',
    judge({ ...ok, apiTotal: 16385 + COUNT_TOLERANCE + 1 }).length === 1);
  check('件数の乖離は減ったときも鳴る（片方だけ肥大するとは限らない）',
    judge({ ...ok, apiTotal: 16385 - COUNT_TOLERANCE - 1 }).length === 1);

  check('★版が8日以上遅れていたら鳴る（xlsx廃止の検知）',
    judge({ ...ok, staleCount: 1 }).length === 1, JSON.stringify(judge({ ...ok, staleCount: 1 })));
  check('鳴るときは何が起きたか本文で分かる',
    judge({ ...ok, staleCount: 1 })[0].includes('2026-08-17') && judge({ ...ok, staleCount: 1 })[0].includes('2026-08-25'));
  check('2つ同時に起きたら2件とも出す',
    judge({ ...ok, apiTotal: 0, staleCount: 5 }).length === 2);
}

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
