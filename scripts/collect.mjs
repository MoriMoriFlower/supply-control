/**
 * 厚労省の供給状況xlsxを取得し、正規化して data/ に保存する。
 * GitHub Actions から1日2回呼ばれる。手元でも `npm run collect` で同じことが起きる。
 *
 * 出力：
 *   data/meta.json            版情報・件数・直近の差分サマリ
 *   data/items.json           品目の素性（①〜⑪）。ほぼ変わらない
 *   data/status.json          供給状況（⑫〜㉑）。毎日変わりうる
 *   data/changes/YYYY-MM-DD.json  その版で変化したもの
 *   data/changes/latest.json      いちばん新しい差分（PWAはこれを見る）
 *
 * 履歴は git そのものに任せる。上書きコミットしていけば
 * `git log -p data/status.json` で過去の任意の日の状態に戻れる。
 * （厚労省は最新版1本しか置かないので、貯めた履歴はここにしか無い＝共通ノウハウ F-7）
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveSource, download, parseWorkbook, checkKey } from './lib/mhlw.mjs';
import { buildChanges, tally } from './lib/diff.mjs';
import { ITEM_KEYS, STATUS_KEYS, KEY } from './lib/schema.mjs';

const DATA = path.resolve('data');
const CHANGES = path.join(DATA, 'changes');

/** 1行1レコードで書く。gitのdiffが「変わった品目の行だけ」になり、履歴が軽くなる */
function serializeRows(header, columns, rows) {
  const head = Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = rows.map((r) => JSON.stringify(columns.map((c) => r[c]))).join(',\n');
  return `{\n${head.join(',\n')},\n"columns": ${JSON.stringify(columns)},\n"rows": [\n${body}\n]\n}\n`;
}

async function readRows(file) {
  if (!existsSync(file)) return null;
  const json = JSON.parse(await readFile(file, 'utf8'));
  const cols = json.columns;
  return {
    meta: json,
    map: new Map(json.rows.map((r) => [r[cols.indexOf(KEY)], Object.fromEntries(cols.map((c, i) => [c, r[i]]))])),
  };
}

const log = (...a) => console.log(...a);

async function main() {
  await mkdir(CHANGES, { recursive: true });

  // 1. どのファイルを取ればよいか（ページから毎回引く。URLを固定で持たない）
  const src = await resolveSource();
  log(`版: ${src.asOf}（${src.linkText}）`);
  log(`URL: ${src.url}`);

  // 2. 落とす。1.5MB程度なので毎回落として中身のハッシュで判断する
  const dl = await download(src.url);
  log(`取得: ${dl.bytes.toLocaleString()} バイト / sha256=${dl.sha256.slice(0, 16)}… / Last-Modified=${dl.lastModified}`);

  const metaFile = path.join(DATA, 'meta.json');
  const prevMeta = existsSync(metaFile) ? JSON.parse(await readFile(metaFile, 'utf8')) : null;
  if (prevMeta?.source?.sha256 === dl.sha256) {
    log(`変化なし（前回と同一ファイル。版 ${prevMeta.source.asOf}）。保存せず終了`);
    await summary([`### 変化なし`, ``, `前回と同じファイル（版 **${prevMeta.source.asOf}**）でした。`]);
    return;
  }

  // 3. 読む（列構成が変わっていたらここで例外）
  const rows = await parseWorkbook(dl.buf);
  const key = checkKey(rows, KEY);
  log(`解析: ${rows.length.toLocaleString()} 行 / YJユニーク ${key.unique.toLocaleString()} / 12桁でないYJ ${key.nonStandard} 件`);

  // 4. 差分（前回の保存物と突き合わせる）
  const prevItems = await readRows(path.join(DATA, 'items.json'));
  const prevStatus = await readRows(path.join(DATA, 'status.json'));
  const prevAll = new Map();
  if (prevItems && prevStatus) {
    for (const [yj, it] of prevItems.map) prevAll.set(yj, { ...it, ...(prevStatus.map.get(yj) ?? {}) });
  }
  const currAll = new Map(rows.map((r) => [r[KEY], r]));

  const first = prevAll.size === 0;
  const { changes, summary: diffSummary } = first
    ? { changes: [], summary: { total: 0, notify: 0, added: 0, removed: 0, shukka: 0, ryo: 0, detail: 0 } }
    : buildChanges(prevAll, currAll);

  const prevAsOf = prevMeta?.source?.asOf ?? null;
  log(
    first
      ? '初回のため差分なし（次回から前回との比較が始まる）'
      : `差分: 計${diffSummary.total}件（通知対象${diffSummary.notify} / 出荷対応${diffSummary.shukka} / 出荷量${diffSummary.ryo} / 詳細${diffSummary.detail} / 新規${diffSummary.added} / 掲載終了${diffSummary.removed}）`
  );

  // 5. 書く
  const counts = { rows: rows.length, shukka: tally(rows, 'shukka'), ryo: tally(rows, 'ryo') };

  await writeFile(
    path.join(DATA, 'items.json'),
    serializeRows({ asOf: src.asOf }, ITEM_KEYS, rows),
    'utf8'
  );
  await writeFile(
    path.join(DATA, 'status.json'),
    serializeRows({ asOf: src.asOf }, STATUS_KEYS, rows),
    'utf8'
  );

  const changeDoc = {
    asOf: src.asOf,
    prevAsOf,
    first,
    collectedAt: new Date().toISOString(),
    summary: diffSummary,
    changes,
  };
  const changeFile = await uniqueChangeFile(src.asOf);
  await writeFile(changeFile, JSON.stringify(changeDoc, null, 1) + '\n', 'utf8');
  await writeFile(path.join(CHANGES, 'latest.json'), JSON.stringify(changeDoc, null, 1) + '\n', 'utf8');

  await writeFile(
    metaFile,
    JSON.stringify(
      {
        source: {
          page: src.pageUrl,
          file: src.url,
          linkText: src.linkText,
          asOf: src.asOf,
          sha256: dl.sha256,
          bytes: dl.bytes,
          lastModified: dl.lastModified,
        },
        collectedAt: new Date().toISOString(),
        counts,
        key,
        latestChanges: { file: `changes/${path.basename(changeFile)}`, prevAsOf, ...diffSummary },
        license: '出典：厚生労働省「医療用医薬品の供給状況（供給状況一覧表）」を加工して作成',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  log(`保存: data/items.json / data/status.json / ${path.relative(process.cwd(), changeFile)} / data/meta.json`);

  // 6. Actions の実行結果画面に出すサマリ
  const top = changes
    .filter((c) => c.notify)
    .slice(0, 20)
    .map((c) => {
      const f = c.fields.map((x) => `${x.label}: ${x.from || '(空)'} → ${x.to || '(空)'}`).join(' / ');
      return `| ${c.hinmei} | ${c.maker} | ${{ added: '新規掲載', removed: '掲載終了', shukka: '出荷対応', ryo: '出荷量', detail: '詳細' }[c.kind]} | ${f || c.shukka} |`;
    });
  await summary([
    `### 版 ${src.asOf}${prevAsOf ? `（前回 ${prevAsOf}）` : ''}`,
    ``,
    `- 全 ${rows.length.toLocaleString()} 品目`,
    `- 変化 **${diffSummary.total}** 件（うち通知対象 **${diffSummary.notify}** 件）`,
    `- 内訳: 出荷対応 ${diffSummary.shukka} / 出荷量 ${diffSummary.ryo} / 詳細 ${diffSummary.detail} / 新規 ${diffSummary.added} / 掲載終了 ${diffSummary.removed}`,
    ...(top.length ? [``, `| 品名 | 製造販売業者 | 種別 | 変化 |`, `|---|---|---|---|`, ...top] : []),
    ...(first ? [``, `> 初回のため差分は取っていない。次回から比較が始まる。`] : []),
  ]);
}

/** 同じ版が日中に差し替わったときに、前の差分を潰さないようにする */
async function uniqueChangeFile(asOf) {
  const base = path.join(CHANGES, `${asOf}.json`);
  if (!existsSync(base)) return base;
  const files = await readdir(CHANGES);
  let n = 2;
  while (files.includes(`${asOf}-r${n}.json`)) n++;
  return path.join(CHANGES, `${asOf}-r${n}.json`);
}

async function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) await writeFile(f, lines.join('\n') + '\n', { flag: 'a' });
}

main().catch((err) => {
  console.error('\n★ 取得を中止した：\n' + (err?.stack ?? err));
  process.exit(1);
});
