/**
 * 画面。
 *
 * 方針（SupplyControl/CLAUDE.md 2節）：
 *  - 出す文言は厚労省の原本そのまま。言い換えない・解釈を足さない。
 *  - 「在庫がある/ない」「代替はこれ」といった判断は一切書かない。
 *  - 気になる薬リストは端末から出さない。送信する処理をここに足さないこと。
 */
import { addWatch, removeWatch, listWatch } from './db.js';
import { loadMeta, loadSearch, loadStatus, loadChanges } from './data.js';
import { normalize, haystack, terms, matches } from './normalize.js';

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  rows: [],      // search.json の全品目
  hays: [],      // rows と同じ並びの検索キー（全項目）
  names: [],     // rows と同じ並びの検索キー（品名だけ。並べ替えに使う）
  status: new Map(),
  changes: null,
  changed: new Map(), // yj → 直近の変化
  watch: [],
};

/* ---------- 表示の部品 ---------- */

/** 原本の値から見た目の強さを決める。分類そのものは厚労省のもので、こちらの判断は足さない */
function severity(shukka) {
  if (!shukka) return '';
  if (shukka.startsWith('⑤')) return 'stop';
  if (shukka.startsWith('②') || shukka.startsWith('③') || shukka.startsWith('④')) return 'limited';
  return 'normal';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * 1品目のカード。
 * @param {object} row 品目（品名などは原本のまま）
 * @param {object} opts { action: '追加'|'削除'|null, onAction, change }
 */
function card(row, opts = {}) {
  const box = el('article', 'card');

  const head = el('div', 'card-head');
  head.append(el('h3', null, row.hinmei || '(品名なし)'));
  if (opts.action) {
    const b = el('button', `act ${opts.action === '削除' ? 'del' : ''}`, opts.action);
    b.type = 'button';
    b.addEventListener('click', () => opts.onAction(row));
    head.append(b);
  } else if (opts.registered) {
    head.append(el('span', 'act done', '登録済み'));
  }
  box.append(head);

  const sub = [row.kikaku, row.maker].filter(Boolean).join('　');
  if (sub) box.append(el('p', 'sub', sub));
  if (row.seibun) box.append(el('p', 'sub dim', row.seibun));

  const st = state.status.get(row.yj);
  if (st) {
    const badges = el('div', 'badges');
    badges.append(el('span', `badge ${severity(st.shukka)}`, st.shukka));
    if (st.ryo) badges.append(el('span', 'badge plain', st.ryo));
    box.append(badges);
  }

  const ch = opts.change ?? state.changed.get(row.yj);
  if (ch) box.append(changeNote(ch));

  return box;
}

const KIND_LABEL = {
  added: '新規掲載',
  removed: '掲載終了',
  shukka: '出荷対応が変化',
  ryo: '出荷量が変化',
  detail: '詳細が更新',
};

function changeNote(ch) {
  const box = el('div', 'change');
  box.append(el('span', `tag ${ch.kind}`, KIND_LABEL[ch.kind] ?? ch.kind));
  for (const f of ch.fields ?? []) {
    const line = el('p', 'diff');
    line.append(el('span', 'k', f.label));
    line.append(el('span', 'from', f.from || '(空欄)'));
    line.append(el('span', 'arrow', '→'));
    line.append(el('span', 'to', f.to || '(空欄)'));
    box.append(line);
  }
  return box;
}

function fill(node, children, emptyText) {
  node.replaceChildren();
  if (!children.length) {
    node.append(el('p', 'empty', emptyText));
    return;
  }
  for (const c of children) node.append(c);
}

/* ---------- 各タブ ---------- */

async function renderWatch() {
  state.watch = await listWatch();
  const cards = state.watch.map((w) =>
    card(w, {
      action: '削除',
      onAction: async (row) => {
        await removeWatch(row.yj);
        await renderWatch();
      },
    })
  );
  fill(
    $('watch-list'),
    cards,
    'まだ登録がありません。「さがす」から、気になる薬を追加してください。'
  );
}

const LIMIT = 100;

function renderSearch() {
  const words = terms($('q').value);
  const note = $('search-note');

  if (!words.length) {
    note.textContent = '品名でも成分名でも引けます。ひらがな・半角でも当たります。';
    $('search-list').replaceChildren();
    return;
  }

  // 添字で拾ってから並べ替える（並べ替えに検索キーを使うため）
  const hits = [];
  for (let i = 0; i < state.rows.length; i++) {
    if (matches(state.hays[i], words)) hits.push(i);
  }

  // 「アムロジピン 5mg」のような数字混じりの語は部分一致で広めに当たる
  //（記号を落とすので「2.5mg」も「5mg」を含む）。消さずに、並べ方で目的の薬を上に出す。
  //   1. 品名が検索語で始まる
  //   2. 品名に検索語が入っている（成分名だけの一致より上）
  //   3. 品名が短い（「ロキソニン錠60mg」を「…錠60mg『トーワ』」より上に）
  const rank = (i) => {
    const n = state.names[i];
    if (words.every((w) => n.startsWith(w))) return 0;
    if (words.every((w) => n.includes(w))) return 1;
    return 2;
  };
  hits.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      state.names[a].length - state.names[b].length ||
      (state.rows[a].hinmei ?? '').localeCompare(state.rows[b].hinmei ?? '', 'ja')
  );

  const registered = new Set(state.watch.map((w) => w.yj));
  note.textContent =
    hits.length > LIMIT
      ? `${hits.length.toLocaleString()} 件（先頭 ${LIMIT} 件を表示。語を足すと絞れます）`
      : `${hits.length.toLocaleString()} 件`;

  fill(
    $('search-list'),
    hits.slice(0, LIMIT).map((i) => {
      const r = state.rows[i];
      return registered.has(r.yj)
        ? card(r, { registered: true })
        : card(r, {
            action: '追加',
            onAction: async (row) => {
              await addWatch(row);
              await renderWatch();
              renderSearch();
            },
          });
    }),
    '当てはまる薬がありません。'
  );
}

function renderChanges() {
  const c = state.changes;
  const note = $('changes-note');
  if (!c) {
    note.textContent = '';
    return;
  }

  if (c.first) {
    note.textContent = `版 ${c.asOf}。初回の取り込みのため、比較する前回分がありません。次の更新から変化が出ます。`;
  } else {
    note.textContent = `版 ${c.asOf}（前回 ${c.prevAsOf}）で ${c.summary.total.toLocaleString()} 件が変化しました。`;
  }

  fill(
    $('changes-list'),
    (c.changes ?? []).map((ch) => card(ch, { change: ch, registered: state.watch.some((w) => w.yj === ch.yj) })),
    c.first ? '' : 'この版で変化した品目はありません。'
  );
}

/* ---------- 起動 ---------- */

function tabs() {
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === `tab-${b.dataset.tab}`);
    if (b.dataset.tab === 'search') $('q').focus();
  });

  let t = null;
  $('q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(renderSearch, 80); // 全16,384件を毎打鍵で走査しても数msだが、描画のほうが重いので少し待つ
  });
}

function fail(message, err) {
  console.error(err);
  $('asof').textContent = message;
  $('asof').classList.add('err');
}

async function main() {
  tabs();
  await renderWatch(); // 通信を待たずに、まず端末内のリストを出す

  let meta;
  try {
    meta = await loadMeta();
  } catch (err) {
    return fail('データを取得できませんでした。通信を確認してください。', err);
  }
  state.meta = meta;
  $('asof').textContent = `厚生労働省 ${meta.source.asOf} 版／全 ${meta.counts.rows.toLocaleString()} 品目`;
  $('src-link').href = meta.source.page;

  try {
    const [search, status, changes] = await Promise.all([loadSearch(meta), loadStatus(meta), loadChanges()]);
    state.rows = search.rows;
    state.hays = search.rows.map(haystack);
    state.names = search.rows.map((r) => normalize(r.hinmei));
    state.status = status;
    state.changes = changes;
    state.changed = new Map((changes.changes ?? []).map((c) => [c.yj, c]));
  } catch (err) {
    return fail('データの読み込みに失敗しました。時間をおいて開き直してください。', err);
  }

  await renderWatch();
  renderChanges();
  renderSearch();
}

main();
