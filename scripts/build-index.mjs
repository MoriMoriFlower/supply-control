/**
 * 画面（PWA）が使う軽い索引を、保存済みの data/ から作り直す。
 *
 *   data/search.json       薬を探すための最小限。品名・成分名・製造販売業者・規格・YJ
 *   data/status-lite.json  今の出荷対応と出荷量だけ。値はコード（整数）で持つ
 *
 * なぜ items.json / status.json をそのまま配らないのか：
 *   転送量は brotli が効くのでどちらでも大差ない（実測 items 3,755KB → 229KB）。
 *   問題は**端末側の解析コスト**で、iPhoneに 5.6MB の JSON を毎回 JSON.parse させたくない。
 *   画面が実際に使う列だけにすると生サイズが 1/3 以下になる。
 *
 * なぜ2つに分けるのか：
 *   search.json は品目の素性なので**めったに変わらない**（新規収載・掲載終了のときだけ）。
 *   status-lite.json は**毎日変わる**。分けておけば、PWAは meta.json のハッシュを見て
 *   「重いほうは前回のまま」と判断でき、毎日の通信が数十KBで済む。
 *
 * ★このスクリプトは外部アクセスをしない。保存済みJSONを読むだけなので、
 *   書式を変えたくなったら `npm run index` でいつでも作り直せる。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { serializeRows, deserializeRows } from './lib/serialize.mjs';
import { KEY, SHUKKA_VALUES, RYO_VALUES } from './lib/schema.mjs';

const DATA = path.resolve('data');

/** 検索に使う列。ここに無い列は search.json に載らない */
const SEARCH_KEYS = [KEY, 'hinmei', 'seibun', 'maker', 'kikaku'];

const log = (...a) => console.log(...a);

/**
 * 値→コード（配列の添字）。schema の既知の値は添字が固定される。
 * 未知の値は末尾に足して警告を返す（止めはしない）。
 */
function coder(known, label) {
  const table = [...known];
  const index = new Map(table.map((v, i) => [v, i]));
  const unknown = new Map();
  return {
    table,
    code(v) {
      const hit = index.get(v);
      if (hit !== undefined) return hit;
      unknown.set(v, (unknown.get(v) ?? 0) + 1);
      const i = table.length;
      table.push(v);
      index.set(v, i);
      return i;
    },
    warnings() {
      return [...unknown.entries()].map(
        ([v, n]) => `${label}に未知の値「${v}」が ${n} 件。schema.mjs の一覧に追記すること`
      );
    },
  };
}

async function readTable(name) {
  const json = JSON.parse(await readFile(path.join(DATA, name), 'utf8'));
  return { asOf: json.asOf, rows: deserializeRows(json) };
}

export async function buildIndex() {
  const items = await readTable('items.json');
  const status = await readTable('status.json');

  if (items.asOf !== status.asOf) {
    throw new Error(
      `items.json（${items.asOf}）と status.json（${status.asOf}）の版が食い違っている。` +
        `片方だけ書き換わった可能性があるので、npm run collect からやり直すこと`
    );
  }

  const statusByKey = new Map(status.rows.map((r) => [r[KEY], r]));
  if (statusByKey.size !== items.rows.length) {
    throw new Error(`行数が合わない：items ${items.rows.length} 件 / status ${statusByKey.size} 件`);
  }

  // ★YJ順に固定する。厚労省側の行順が入れ替わっても索引のdiffが出ないようにするため。
  //   （items.json / status.json は原本の行順のまま。索引だけ並べ替える）
  const rows = [...items.rows].sort((a, b) => (a[KEY] < b[KEY] ? -1 : a[KEY] > b[KEY] ? 1 : 0));

  const shukka = coder(SHUKKA_VALUES, '⑫出荷対応');
  const ryo = coder(RYO_VALUES, '⑰出荷量');

  const lite = rows.map((it) => {
    const st = statusByKey.get(it[KEY]);
    if (!st) throw new Error(`status.json に ${it[KEY]} が無い`);
    return [it[KEY], shukka.code(st.shukka), ryo.code(st.ryo)];
  });

  // ★索引には版（asOf）を書かない。
  //   書くと「中身は前日と同じなのにハッシュだけ変わる」日ができて、
  //   PWAが 2MB の search.json を無駄に取り直す。版は meta.json が持てば足りる。
  const searchText = serializeRows({}, SEARCH_KEYS, rows);
  const liteText = serializeRows(
    { shukkaValues: shukka.table, ryoValues: ryo.table },
    [KEY, 'shukka', 'ryo'],
    lite,
    (r) => r
  );

  await writeFile(path.join(DATA, 'search.json'), searchText, 'utf8');
  await writeFile(path.join(DATA, 'status-lite.json'), liteText, 'utf8');

  const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const stat = (s) => ({ bytes: Buffer.byteLength(s), sha256: digest(s) });

  const index = {
    asOf: items.asOf,
    rows: rows.length,
    'search.json': stat(searchText),
    'status-lite.json': stat(liteText),
  };

  // meta.json に索引の指紋を残す。PWAは軽い meta.json だけ見て
  // 「search.json は前回と同じだから取り直さない」と判断できる
  const metaFile = path.join(DATA, 'meta.json');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  meta.index = index;
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const warnings = [...shukka.warnings(), ...ryo.warnings()];
  return { index, warnings };
}

async function main() {
  const { index, warnings } = await buildIndex();
  const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
  log(`索引を作成（版 ${index.asOf} / ${index.rows.toLocaleString()} 件）`);
  log(`  data/search.json      ${kb(index['search.json'].bytes)}`);
  log(`  data/status-lite.json ${kb(index['status-lite.json'].bytes)}`);
  for (const w of warnings) log(`  ★警告: ${w}`);

  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f && warnings.length) {
    await writeFile(f, [``, `### ★索引の警告`, ``, ...warnings.map((w) => `- ${w}`), ``].join('\n'), { flag: 'a' });
  }
}

// 直接叩かれたときだけ実行する（selftest.mjs からは buildIndex() を import する）。
// ★Windowsのパスは file:///C:/... になるので、自前で組み立てず pathToFileURL を使う
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n★ 索引の作成を中止した：\n' + (err?.stack ?? err));
    process.exit(1);
  });
}
