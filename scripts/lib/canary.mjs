/**
 * カナリア：新システム「医薬品安定供給状況等管理システム」の公開APIと突き合わせて、
 * 主データ源である厚労省xlsxが「静かに止まっていないか」を見張る。
 *
 * ★立ち位置を取り違えないこと。
 *   主データ源はあくまで厚労省が公表するxlsx。列見出しの逐語照合（E-13）と自己テストはそこに乗っている。
 *   このAPIは非公表でドキュメントも無いので、保存するデータの主語にはしない。
 *   ここでやるのは「xlsxが死んだことに気付く」ためだけの見張りであり、
 *   ★APIが落ちていても本体の取得は絶対に止めない（だから例外を外へ投げない）。
 *
 * なぜ要るか：xlsxが廃止されると collect は「前回と同一ファイル → 変化なし」で
 * 静かに成功し続ける。何も壊れていないように見えたまま、通知だけが永久に来なくなる。
 * 「0件・変化なしは“結果”ではなく“照合が成立しなかったサイン”」（総則1）をここで機械化する。
 *
 * 見張る2つ：
 *  1. 件数の乖離 …… APIの total と、こちらの行数（2026-08-17実測でどちらも 16,385 でぴったり一致）
 *  2. 版の遅れ   …… APIに「こちらの版より STALE_DAYS 日以上あとに掲載された品目」があるか
 */

export const API = 'https://iyakuhin-kyokyu.mhlw.go.jp/api/info-site/supply-status-report';

/**
 * 何日ぶん遅れたら異常とみなすか。
 *
 * xlsxの更新は平日のみで、しかも毎営業日ではない（直近90日の平日65日中48日＝74%）。
 * お盆は特に空く（2026年は 8/11〜8/13 に記録が無い）。
 * ★数日の空きで鳴ると「またか」で読まれなくなるので、余裕をもって8日で切る。
 *   1週間まるごと止まったら、それは休みではなく異常。
 */
export const STALE_DAYS = 8;

/**
 * 件数の差をどこまで許すか。
 *
 * 両者の更新時刻はずれるので、1日ぶんの増減（実測で1日あたり中央値12件）は乖離ではない。
 * 桁が変わるような食い違いだけを拾う。
 */
export const COUNT_TOLERANCE = 100;

export const TIMEOUT_MS = 15000;

/** 誰が叩いているか名乗る。公的機関のサイトに無言でアクセスしない */
const UA = 'SupplyControl-canary/1.0 (+https://github.com/MoriMoriFlower/supply-control)';

/** 'YYYY-MM-DD' に日数を足す。UTC固定で計算するのでタイムゾーンでずれない */
export function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const p = (v) => String(v).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/**
 * 数字を見て異常かどうかを決める部分。
 * ★ネットワークを触らない純粋関数にしてある。自己テストがここを直接叩けるようにするため。
 *
 * @returns {string[]} 異常の説明。空配列なら正常
 */
export function judge({ asOf, rows, apiTotal, staleCount, staleFrom }) {
  const alerts = [];

  const gap = Math.abs(apiTotal - rows);
  if (gap > COUNT_TOLERANCE) {
    alerts.push(
      `件数が乖離している：xlsx ${rows.toLocaleString()}件 / API ${apiTotal.toLocaleString()}件（差 ${gap.toLocaleString()}件・許容 ${COUNT_TOLERANCE}件）`
    );
  }

  if (staleCount > 0) {
    alerts.push(
      `xlsxが止まっている可能性：こちらの版は ${asOf} だが、APIには ${staleFrom} 以降に掲載された品目が ${staleCount.toLocaleString()}件ある` +
        `（${STALE_DAYS}日以上の遅れ）。厚労省のxlsxが廃止・移動していないか確認すること`
    );
  }

  return alerts;
}

/** API に件数だけ聞く（limit=1 で1件も本文を持ち帰らない） */
async function ask(params = {}) {
  const url = new URL(API);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', '1');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const json = await res.json();
  // ★「取れなかった」を「0件だった」に化けさせない（総則5・E-13）
  if (typeof json?.total !== 'number') throw new Error('応答に total が無い（APIの仕様が変わった可能性）');
  return json.total;
}

/**
 * 見張りを1回実行する。
 * ★成功しても失敗しても例外を投げない。呼び出し側の処理を絶対に巻き込まない。
 *
 * @param {{asOf: string, rows: number}} state いまこちらが持っている版と件数
 */
export async function runCanary({ asOf, rows }) {
  const checkedAt = new Date().toISOString();
  try {
    const apiTotal = await ask();

    // こちらの版より後に掲載されたものがあるか。正常なら0（2026-08-17実測で0）
    const newerFrom = addDays(asOf, 1);
    const newerThanAsOf = await ask({ publication_date_from: newerFrom });

    // 0件なら遅れは有り得ないので、無駄に叩かない
    const staleFrom = addDays(asOf, STALE_DAYS);
    const staleCount = newerThanAsOf === 0 ? 0 : await ask({ publication_date_from: staleFrom });

    return {
      ok: true,
      checkedAt,
      asOf,
      rows,
      apiTotal,
      newerFrom,
      newerThanAsOf,
      staleFrom,
      staleCount,
      alerts: judge({ asOf, rows, apiTotal, staleCount, staleFrom }),
    };
  } catch (err) {
    // 非公表APIなので落ちること自体は異常ではない。記録だけ残して素通りする。
    // ★ここを alerts に入れない。APIの不調で毎日鳴ると、本当の異常が埋もれる
    return { ok: false, checkedAt, asOf, rows, error: String(err?.message ?? err), alerts: [] };
  }
}

/** Actions のログ・サマリに出す文面（人が読む用） */
export function describe(c) {
  if (!c.ok) return [`- カナリア: 照合できず（${c.error}）。xlsx側の取得には影響しない`];
  const head = `- カナリア: API ${c.apiTotal.toLocaleString()}件 / xlsx ${c.rows.toLocaleString()}件（差 ${Math.abs(c.apiTotal - c.rows)}）・版より新しい掲載 ${c.newerThanAsOf}件`;
  return c.alerts.length ? [head, ...c.alerts.map((a) => `- **★${a}**`)] : [head];
}
