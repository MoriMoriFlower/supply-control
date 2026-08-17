/**
 * SVGからPNGアイコンを作る。
 *
 * ★これは「たまに手で回す」スクリプトで、npm run build / GitHub Actions からは呼ばない。
 *   理由：外部コマンド（mutool）に依存するため。Actions のランナーには入っていない。
 *   出来上がったPNGはリポジトリにコミットするので、普段は誰も実行しなくてよい。
 *   絵柄（pwa/icons/*.svg）を変えたときだけ `npm run icons` を回して、PNGも一緒にコミットする。
 *
 * なぜPNGが要るか：
 *   ★iOSは manifest の SVG アイコンを見ない。apple-touch-icon（PNG）が無いと、
 *     ホーム画面に追加したときアイコンが空白かページのスクショになる。
 *
 * 使う道具：mutool（MuPDF 1.23.0・winget導入済み・PATH登録済み）
 *   共通ノウハウ F-3 に「mutoolでSVGを見るとグラデーションが消える」とあるが、
 *   このアイコンは単色の塗りだけなので該当しない（実際の出力を目視で確認済み・2026-08-17）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ICONS = path.resolve('pwa', 'icons');

/**
 * 作るもの。
 * - alpha:true  … 角の外側を透過にする（そのまま表示される用途）
 * - alpha:false … 全面不透明（相手側がマスクを被せる用途。透過だと角が白or黒に化ける）
 */
const TARGETS = [
  { out: 'icon-192.png',          src: 'icon.svg',      size: 192, alpha: true,  use: 'manifest（purpose any）' },
  { out: 'icon-512.png',          src: 'icon.svg',      size: 512, alpha: true,  use: 'manifest（purpose any）・スプラッシュ' },
  { out: 'icon-maskable-512.png', src: 'icon-full.svg', size: 512, alpha: false, use: 'manifest（purpose maskable）Androidが切り抜く' },
  { out: 'apple-touch-icon.png',  src: 'icon-full.svg', size: 180, alpha: false, use: '★iOSホーム画面。これが本命' },
];

/** PNGの中身を読んで、本当に意図どおりのものが出来たか確かめる */
function inspect(file) {
  const b = readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 33 || !b.subarray(0, 8).equals(sig)) throw new Error(`${file} はPNGではない`);
  if (b.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error(`${file} のIHDRが読めない`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25], bytes: b.length };
}

function main() {
  // ★外部コマンドが無いのに「成功した」ことにしない（共通ノウハウ E-13）。
  //   ここで落としておかないと、古いPNGが残ったまま「作り直した」と錯覚する
  try {
    execFileSync('mutool', ['-v'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'mutool が見つからない。\n' +
        '  これは手動実行用のスクリプトで、mutool（MuPDF）が要る。\n' +
        '  導入済みのはずなので、新しいシェルを開き直すと通ることが多い（PATH反映待ち）。'
    );
  }

  mkdirSync(ICONS, { recursive: true });
  const rows = [];

  for (const t of TARGETS) {
    const src = path.join(ICONS, t.src);
    const out = path.join(ICONS, t.out);
    const args = ['draw'];
    if (t.alpha) args.push('-c', 'rgba'); // 既定は rgb（＝不透明・余白は白）
    args.push('-w', String(t.size), '-h', String(t.size), '-o', out, src);

    execFileSync('mutool', args, { stdio: 'pipe' });

    const got = inspect(out);
    if (got.width !== t.size || got.height !== t.size) {
      throw new Error(`${t.out} のサイズが違う：期待 ${t.size}px / 実際 ${got.width}x${got.height}`);
    }
    const wantType = t.alpha ? 6 : 2; // 6=RGBA / 2=RGB
    if (got.colorType !== wantType) {
      throw new Error(`${t.out} の色形式が違う：期待 ${wantType} / 実際 ${got.colorType}`);
    }
    rows.push([t.out, `${t.size}px`, t.alpha ? '透過あり' : '不透明', `${(got.bytes / 1024).toFixed(1)}KB`, t.use]);
  }

  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => [...r[i]].length)));
  for (const r of rows) {
    console.log(`  ${r[0].padEnd(w[0])}  ${r[1].padStart(w[1])}  ${r[2].padEnd(w[2])}  ${r[3].padStart(w[3])}  ${r[4]}`);
  }
  console.log(`\nアイコン ${rows.length}件を作成した。忘れずにコミットすること。`);
}

try {
  main();
} catch (err) {
  console.error('\n★ アイコン生成を中止した：\n' + (err?.message ?? err));
  process.exit(1);
}
