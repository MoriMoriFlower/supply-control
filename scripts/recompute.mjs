/**
 * 保存済みの data/changes/*.json の「通知するかどうか」を、いまの判定で付け直す。
 * 外部アクセスなし。何度実行しても結果は同じ（冪等）。
 *
 * ★なぜ要るか。
 *   notify フラグは collect が走った瞬間の判定を焼き付けたもので、あとから判定を直しても
 *   保存済みのファイルは古いままになる。しかも collect は元ファイルが変わらない日は
 *   「変化なし」で早期終了するので、次の更新日まで直りが反映されない。
 *
 *   実際に踏んだ（2026-08-17）：⑰出荷量の変化を通知するよう直したのに、
 *   その日の data/changes/2026-08-17.json は notify=0 のままだった。
 *   ユナスピン静注用1.5g（⑫①のまま A→B）が、直したはずの実装でも記録上は沈黙していた。
 *
 * ★このスクリプトは「判定」を持たない。scripts/lib/diff.mjs の isNotifiable をそのまま呼ぶ。
 *   判定を2箇所に書くと、片方だけ直して食い違うのが目に見えている。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isNotifiable } from './lib/diff.mjs';

const DATA = path.resolve('data');
const CHANGES = path.join(DATA, 'changes');

/** 1ファイルぶん付け直す。書き換えが要るときだけ true を返す */
function recompute(doc) {
  let moved = 0;
  const flipped = [];

  for (const c of doc.changes ?? []) {
    const now = isNotifiable(c.kind, { shukka: c.shukka, ryo: c.ryo }, c.fields ?? []);
    if (now !== c.notify) {
      flipped.push(`${now ? '沈黙→通知' : '通知→沈黙'}  ${c.hinmei}  ${(c.fields ?? []).map((f) => `${f.label}: ${f.from || '(空)'} → ${f.to || '(空)'}`).join(' / ') || c.kind}`);
      c.notify = now;
      moved++;
    }
  }

  if (doc.summary) doc.summary.notify = (doc.changes ?? []).filter((c) => c.notify).length;
  return { moved, flipped, notify: doc.summary?.notify ?? 0 };
}

async function main() {
  if (!existsSync(CHANGES)) {
    console.log('data/changes/ が無い。まず npm run collect を実行すること');
    return;
  }

  const files = (await readdir(CHANGES)).filter((f) => f.endsWith('.json')).sort();
  let touched = 0;

  for (const f of files) {
    const file = path.join(CHANGES, f);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const r = recompute(doc);
    if (!r.moved) continue;

    await writeFile(file, JSON.stringify(doc, null, 1) + '\n', 'utf8');
    touched++;
    console.log(`\n${f}: ${r.moved}件を付け直した（通知対象は ${r.notify}件になった）`);
    for (const line of r.flipped) console.log(`  ${line}`);
  }

  // meta.json の写しも合わせる。ここがズレるとコミットメッセージとActionsのサマリが嘘になる
  const metaFile = path.join(DATA, 'meta.json');
  if (existsSync(metaFile)) {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const latest = path.join(CHANGES, 'latest.json');
    if (meta.latestChanges && existsSync(latest)) {
      const doc = JSON.parse(await readFile(latest, 'utf8'));
      const n = (doc.changes ?? []).filter((c) => c.notify).length;
      if (meta.latestChanges.notify !== n) {
        console.log(`\nmeta.json: latestChanges.notify を ${meta.latestChanges.notify} → ${n} に直した`);
        meta.latestChanges.notify = n;
        await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
        touched++;
      }
    }
  }

  console.log(touched ? `\n${touched}ファイルを更新した。忘れずにコミットすること。` : `\n${files.length}ファイルすべて、いまの判定と一致していた（変更なし）。`);
}

main().catch((err) => {
  console.error('\n★ 付け直しを中止した：\n' + (err?.stack ?? err));
  process.exit(1);
});
