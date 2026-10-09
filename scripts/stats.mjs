/**
 * 運用の実測値を数え直す。外部アクセスなし・読むだけ（何も書き換えない）。
 *
 * ★なぜ要るか：CLAUDE.md に載せている数字は、全部ここから出す。
 *   「数えて書いた数字は、数え方ごと残す。再現できない数字は載せない」（共通ノウハウ F-74）。
 *   2026-09-13 までは手元で使い捨てのスクリプトを書いて消していたので、
 *   CLAUDE.md に「集計スクリプトは残していない」と書く羽目になっていた。その穴を埋めるのがこれ。
 *
 * 出すもの3つ：
 *  A. 通知のうち「公式のお知らせメールでは届かない割合」＝このアプリの存在理由の数字
 *  B. 元ファイルの公開時刻（Last-Modified）の分布＝cronをどこに張るかの根拠
 *  C. 公開から取得までの遅れ＝Web Pushを何時に鳴らしてよいかの根拠
 *
 * 使い方: npm run stats
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const CHANGES = path.join(DATA, 'changes');

const p2 = (v) => String(v).padStart(2, '0');

/** UTCのISO文字列を日本時間の 'YYYY-MM-DD HH:MM' にする（Actionsの記録はUTCなので必ず通す） */
function jst(iso) {
  const t = new Date(new Date(iso).getTime() + 9 * 3600000);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// --- A. 通知のうち、公式では届かない割合 -----------------------------------
//
// ★振り分けは fields[] の key === 'shukka' があるかで行う。kind では振り分けない。
//   1品目で⑫と⑰が同時に変わると diff.mjs の RANK により kind は重いほう＝'shukka' になるので、
//   kind === 'ryo' で数えると「⑰だけ」が過小になる。
function sectionA() {
  const files = readdirSync(CHANGES).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();

  let total = 0, notify = 0, withShukka = 0, ryoOnly = 0, added = 0, removed = 0;
  const trans = new Map();
  const perDay = [];

  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(CHANGES, f), 'utf8'));
    const day = { date: f.replace('.json', ''), n: 0, s: 0, r: 0 };
    for (const c of j.changes ?? []) {
      total++;
      if (!c.notify) continue;
      notify++; day.n++;

      if (c.kind === 'added') { added++; continue; }
      // 掲載終了は公式のお知らせメールの対象（⑫側の出来事）として数える
      if (c.kind === 'removed') { removed++; withShukka++; day.s++; continue; }

      if ((c.fields ?? []).some((x) => x.key === 'shukka')) { withShukka++; day.s++; continue; }

      ryoOnly++; day.r++;
      const ry = (c.fields ?? []).find((x) => x.key === 'ryo');
      if (ry) {
        const k = `${ry.from || '(空)'} → ${ry.to || '(空)'}`;
        trans.set(k, (trans.get(k) ?? 0) + 1);
      }
    }
    perDay.push(day);
  }

  console.log(`\n=== A. 通知のうち、公式のお知らせメールでは届かない割合 ===`);
  console.log(`対象: ${files.length}日ぶん（${files[0].replace('.json', '')} 〜 ${files.at(-1).replace('.json', '')}）`);
  console.log(`全変化 ${total} / 通知対象 ${notify}`);
  console.log(`  ⑫を含む（公式も送る） ${withShukka}（うち掲載終了 ${removed}）`);
  console.log(`  ⑰だけ（公式は沈黙）   ${ryoOnly}`);
  console.log(`  新規掲載               ${added}`);
  console.log(`★${ryoOnly}/${notify} = ${((ryoOnly / notify) * 100).toFixed(1)}% が公式では届かない`);

  console.log(`\n⑰の遷移（⑰だけで通知した ${ryoOnly}件の内訳）`);
  for (const [k, v] of [...trans].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  // ★日ごとの偏りを必ず出す。全期間の割合だけ見ると「毎日6割が沈黙する」と誤読する
  const only0 = perDay.filter((d) => d.n > 0 && d.r === 0).length;
  const onlyAll = perDay.filter((d) => d.n > 0 && d.s === 0).length;
  console.log(`\n日ごとの偏り: ⑰だけが0件の日 ${only0}日 / ⑫が0件の日（公式なら1通も来ない）${onlyAll}日`);
  const worst = [...perDay].sort((a, b) => b.r / (b.n || 1) - a.r / (a.n || 1)).find((d) => d.n >= 10);
  if (worst) console.log(`  最も偏った日（通知10件以上）: ${worst.date} 通知${worst.n}件中 ⑰だけ${worst.r}件`);
}

// --- B/C. 版ごとの公開時刻と、取得までの遅れ --------------------------------
//
// ★git log -p の行ペアリングで読まない。欄の並び順が変わると静かにずれる
//   （2026-10-09 に実際にずれて、asOf に Last-Modified の文字列が入った）。
//   コミットごとに meta.json を丸ごと読んでJSONとして解釈する。
function versions() {
  const shas = execSync('git log --reverse --format=%H -- data/meta.json', { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);

  const seen = new Map(); // asOf → 最初に観測した値
  for (const sha of shas) {
    let j;
    try { j = JSON.parse(execSync(`git show ${sha}:data/meta.json`, { encoding: 'utf8', maxBuffer: 1 << 24 })); }
    catch { continue; } // 欄が揃う前の古いコミットは黙って飛ばす
    const asOf = j?.source?.asOf, lm = j?.source?.lastModified, got = j?.collectedAt;
    if (!asOf || !lm || !got || seen.has(asOf)) continue;
    const pub = jst(lm);
    seen.set(asOf, {
      pub, got: jst(got),
      min: Number(pub.slice(11, 13)) * 60 + Number(pub.slice(14, 16)),
      late: pub.slice(0, 10) !== asOf, // 版の日付と公開日がずれた＝「版の日付＝公開日」ではない実例
      lagMin: Math.round((new Date(got) - new Date(lm)) / 60000),
    });
  }
  return [...seen].map(([asOf, v]) => ({ asOf, ...v })).sort((a, b) => a.asOf.localeCompare(b.asOf));
}

function sectionBC(rows) {
  // ★「最も早い」を全版で出してはいけない。
  //   版の日付の翌日未明に公開された版（実例：2026-10-07版が 10-08 01:13）が、
  //   「時刻だけ」で並べると先頭に来て、実は一番遅いのに一番早い顔をする。
  //   ずれた版は下で別に列挙するので、ここは「当日公開」に限って測る。
  const sameDay = rows.filter((r) => !r.late);
  const byTime = [...sameDay].sort((a, b) => a.min - b.min);
  console.log(`\n=== B. 元ファイルの公開時刻（Last-Modified・JST） ===`);
  console.log(`版の数: ${rows.length}（${rows[0].asOf} 〜 ${rows.at(-1).asOf}）`);
  console.log(`※以下は当日に公開された ${sameDay.length}版での値（版の日付とずれた ${rows.length - sameDay.length}版は下で別記）`);
  console.log(`最も早い ${byTime[0].pub.slice(11)}（${byTime[0].asOf}版）`);
  console.log(`中央値   ${byTime[Math.floor(byTime.length / 2)].pub.slice(11)}`);
  console.log(`最も遅い ${byTime.at(-1).pub.slice(11)}（${byTime.at(-1).asOf}版）`);

  const late = rows.filter((r) => r.late);
  console.log(`\n★版の日付と公開日がずれた版 ${late.length}件（「版の日付＝公開日」ではない）`);
  for (const r of late) console.log(`  ${r.asOf}版 → ${r.pub}`);

  console.log(`\n=== C. 公開から取得までの遅れ ===`);
  const lags = rows.map((r) => r.lagMin);
  console.log(`中央値 ${median(lags)}分 / 最小 ${Math.min(...lags)}分 / 最大 ${Math.max(...lags)}分`);

  // ★ここがWeb Pushの設計に直結する。この時刻にそのまま鳴らすと真夜中に叩き起こす
  const night = rows.filter((r) => Number(r.got.slice(11, 13)) < 6);
  console.log(`\n★取得が未明（JST 00:00〜06:00）になった版 ${night.length}件 / ${rows.length}版（${((night.length / rows.length) * 100).toFixed(0)}%）`);
  for (const r of night) console.log(`  ${r.asOf}版  公開 ${r.pub} → 取得 ${r.got}（${r.lagMin}分後）`);
}

sectionA();
sectionBC(versions());
console.log('');
