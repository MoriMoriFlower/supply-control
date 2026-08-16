/**
 * 配信する形（dist/）を組み立てる。
 *
 *   dist/            ← pwa/ の中身をそのまま
 *   dist/data/       ← data/ のうち、画面が実際に使うものだけ
 *
 * Cloudflare Pages（Git連携型）のビルド設定：
 *   ビルドコマンド        npm run build
 *   ビルド出力ディレクトリ dist
 *
 * ★items.json / status.json は載せない。
 *   画面は search.json と status-lite.json しか読まないので、5.6MB を配る意味がない。
 *   理由・見込みまで出す画面を作るときに、そのとき必要なものを足す。
 *   （原本の全列は git の履歴として残り続けるので、消えるわけではない）
 */
import { cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('dist');

/** 画面が読むファイル。ここに無いものは配信されない */
const SHIP = ['meta.json', 'search.json', 'status-lite.json'];

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // pwa/ をまるごと。_headers や robots.txt も出力の直下に来る必要がある
  await cp(path.resolve('pwa'), OUT, { recursive: true });

  await mkdir(path.join(OUT, 'data'), { recursive: true });
  for (const f of SHIP) {
    await cp(path.resolve('data', f), path.join(OUT, 'data', f));
  }
  // 変化の履歴は1件が数KBなのでまるごと載せる
  await cp(path.resolve('data', 'changes'), path.join(OUT, 'data', 'changes'), { recursive: true });

  // 検索避けが3箇所そろっているか、出力を見て確かめる。
  // 「公開したつもりがない画面が検索に出る」のは取り返しがつかないので、毎回ここで見る
  const missing = [];
  const has = async (p) => !!(await stat(path.join(OUT, p)).catch(() => null));
  if (!(await has('robots.txt'))) missing.push('robots.txt');
  if (!(await has('_headers'))) missing.push('_headers');
  if (missing.length) throw new Error(`検索避けのファイルが出力に無い：${missing.join(' / ')}`);

  let total = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`dist/ を作成（${(total / 1024).toFixed(1)}KB）`);
}

main().catch((err) => {
  console.error('\n★ 組み立てを中止した：\n' + (err?.stack ?? err));
  process.exit(1);
});
