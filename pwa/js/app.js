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
  filter: 'all',
  shown: 0,
  browse: new Map(), // しぼり込み → 品名順に並べた添字。並べ替えが重いので使い回す
};

/* ---------- 表示の部品 ---------- */

/** 原本の値から見た目の強さを決める。分類そのものは厚労省のもので、こちらの判断は足さない */
function severity(shukka) {
  if (!shukka) return '';
  if (shukka.startsWith('⑤')) return 'stop';
  if (shukka.startsWith('②') || shukka.startsWith('③') || shukka.startsWith('④')) return 'limited';
  return 'normal';
}

/**
 * 「調整中」は厚労省の②③④⑤（限定出荷3種＋供給停止）をまとめただけ。
 * こちらで独自の基準を作らない。①通常出荷を調整中に含めることは絶対にしない。
 */
const FILTERS = {
  all: () => true,
  adjust: (s) => s === 'limited' || s === 'stop',
  limited: (s) => s === 'limited',
  stop: (s) => s === 'stop',
};
const FILTER_LABEL = { all: 'すべて', adjust: '調整中', limited: '限定出荷', stop: '供給停止' };

const sevOf = (yj) => severity(state.status.get(yj)?.shukka);

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

  // 見たいのは調整中のもの。上に寄せる（同じ強さの中は品名順）
  const order = { stop: 0, limited: 1 };
  state.watch.sort(
    (a, b) =>
      (order[sevOf(a.yj)] ?? 9) - (order[sevOf(b.yj)] ?? 9) ||
      (a.hinmei ?? '').localeCompare(b.hinmei ?? '', 'ja')
  );

  const note = $('watch-note');
  if (!state.watch.length || !state.status.size) {
    note.textContent = '';
  } else {
    const n = state.watch.filter((w) => FILTERS.adjust(sevOf(w.yj))).length;
    note.textContent = n
      ? `登録 ${state.watch.length} 件のうち、${n} 件がいま調整中です。`
      : `登録 ${state.watch.length} 件。いま調整中のものはありません。`;
  }

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

/** しぼり込みだけで見るとき用。品名順に並べた添字を作って使い回す */
function browseList(filter) {
  let list = state.browse.get(filter);
  if (list) return list;
  const pass = FILTERS[filter];
  list = [];
  for (let i = 0; i < state.rows.length; i++) {
    if (pass(sevOf(state.rows[i].yj))) list.push(i);
  }
  list.sort((a, b) => (state.rows[a].hinmei ?? '').localeCompare(state.rows[b].hinmei ?? '', 'ja'));
  state.browse.set(filter, list);
  return list;
}

function renderSearch() {
  const words = terms($('q').value);
  const note = $('search-note');
  const pass = FILTERS[state.filter];

  // 語もしぼり込みも無い＝16,384件を全部並べても意味がないので、案内だけ出す
  if (!words.length && state.filter === 'all') {
    note.textContent =
      '品名でも成分名でも引けます。ひらがな・半角でも当たります。語を入れずに上のボタンを押すと、いま調整中のものを一覧できます。';
    $('search-list').replaceChildren();
    return;
  }

  let hits;
  if (!words.length) {
    hits = browseList(state.filter);
  } else {
    // 添字で拾ってから並べ替える（並べ替えに検索キーを使うため）
    hits = [];
    for (let i = 0; i < state.rows.length; i++) {
      if (matches(state.hays[i], words) && pass(sevOf(state.rows[i].yj))) hits.push(i);
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
  }

  if (!state.shown) state.shown = LIMIT;
  const shown = Math.min(state.shown, hits.length);

  const head = words.length
    ? `${hits.length.toLocaleString()} 件`
    : `${FILTER_LABEL[state.filter]} ${hits.length.toLocaleString()} 件（品名順）`;
  note.textContent = hits.length > shown ? `${head}・${shown.toLocaleString()} 件まで表示中` : head;

  const registered = new Set(state.watch.map((w) => w.yj));
  const children = hits.slice(0, shown).map((i) => {
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
  });

  if (hits.length > shown) {
    const more = el('button', 'more', `さらに ${Math.min(LIMIT, hits.length - shown).toLocaleString()} 件を表示`);
    more.type = 'button';
    more.addEventListener('click', () => {
      state.shown += LIMIT;
      renderSearch();
    });
    children.push(more);
  }

  fill($('search-list'), children, '当てはまる薬がありません。');
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
    state.shown = LIMIT; // 語を変えたら先頭から見せ直す
    t = setTimeout(renderSearch, 80); // 全16,384件を毎打鍵で走査しても数msだが、描画のほうが重いので少し待つ
  });

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    state.shown = LIMIT;
    for (const x of $('filters').children) x.classList.toggle('on', x === b);
    renderSearch();
  });
}

/** しぼり込みの件数を出す。押す前に「何件あるか」が見えるようにするため */
function renderFilterCounts() {
  for (const b of $('filters').children) {
    const n = b.dataset.filter === 'all' ? state.rows.length : browseList(b.dataset.filter).length;
    b.querySelector('.n').textContent = n.toLocaleString();
  }
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
  renderFilterCounts();
  renderChanges();
  renderSearch();
}

main();
