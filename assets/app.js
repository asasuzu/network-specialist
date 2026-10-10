(() => {
  'use strict';

  const LEVELS = ['基礎', '知識', '過去問'];
  const HONBUN = {
    '◎': '本文を読まなくても解ける',
    '○': '本文を少し確認すれば解ける',
    '△': '本文・図の読み取りが必要',
  };
  const NO_EXAM = 'none';
  const GROUPS = {
    exams: { el: '#examGroup', all: '全年度', short: '年度' },
    decks: { el: '#deckGroup', all: 'すべての分野', short: '分野' },
    levels: { el: '#levelGroup', all: 'すべての段階', short: '段階' },
  };
  const MARKS_KEY = 'nw-cards:marks';
  const PREFS_KEY = 'nw-cards:prefs';

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できない環境でも表示は続ける */ }
    },
  };

  const state = {
    decks: [],
    cards: [],
    marks: store.get(MARKS_KEY, {}),
    prefs: loadPrefs(),
    opts: { exams: [], decks: [], levels: [] },
    sel: { exams: new Set(), decks: new Set(), levels: new Set() },
    list: [],
    index: 0,
    revealed: false,
  };

  // 選択は「全部選んでいれば null」で保存する（カードの年度や分野が増えても、自動で選ばれた状態になる）
  function loadPrefs() {
    const p = Object.assign({ mode: 'test', exams: null, decks: null, levels: null, status: 'all', shuffle: false, filtersOpen: true },
      store.get(PREFS_KEY, {}));
    // 以前の1つだけ選ぶ形式から移す
    if (p.deck && p.deck !== 'all') p.decks = [p.deck];
    if (p.level && p.level !== 'all') p.levels = [p.level];
    if (p.exam && p.exam !== 'all') p.exams = [p.exam];
    delete p.deck; delete p.level; delete p.exam;
    return p;
  }

  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');

  // ---------- カードの読み込み ----------

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Markdown の決まった書き方（# 分野、## グループ、### 問い、- 段階/出典/本文）からカードを取り出す
  function parseDeck(md, file) {
    const deck = { file, title: file, intro: [], cards: [] };
    let group = '';
    let cur = null;
    const flush = () => {
      if (!cur) return;
      cur.body = cur.body.join('\n').trim();
      deck.cards.push(cur);
      cur = null;
    };
    for (const line of md.split(/\r?\n/)) {
      let m;
      if ((m = line.match(/^# (.+)$/))) { deck.title = m[1].trim(); continue; }
      if ((m = line.match(/^## (.+)$/))) { flush(); group = m[1].trim(); continue; }
      if ((m = line.match(/^### (.+)$/))) {
        flush();
        const q = m[1].trim();
        cur = { id: hash(file + '#' + q), deck, group, q, meta: {}, body: [], inMeta: true };
        continue;
      }
      if (cur) {
        if (cur.inMeta) {
          const mm = line.match(/^-\s*(段階|出典|本文|状況)[:：]\s*(.+)$/);
          if (mm) { cur.meta[mm[1]] = mm[2].trim(); continue; }
          if (line.trim() === '') continue;
          cur.inMeta = false;
        }
        cur.body.push(line);
      } else if (!group) {
        deck.intro.push(line);
      }
    }
    flush();
    deck.intro = deck.intro.join(' ').trim();
    return deck;
  }

  async function load() {
    view.innerHTML = '<p class="empty">読み込み中…</p>';
    try {
      const res = await fetch('cards/manifest.json', { cache: 'no-cache' });
      const manifest = await res.json();
      const texts = await Promise.all(manifest.decks.map((f) =>
        fetch('cards/' + f, { cache: 'no-cache' }).then((r) => {
          if (!r.ok) throw new Error(f);
          return r.text();
        })));
      state.decks = manifest.decks.map((f, i) => parseDeck(texts[i], f));
      state.cards = state.decks.flatMap((d) => d.cards);
    } catch (e) {
      view.innerHTML = '<p class="error">カードを読み込めませんでした。<br>ファイルを直接開いている場合は、Webサーバ経由（GitHub Pages など）で開いてください。</p>';
      return;
    }
    buildOptions();
    renderControls();
    rebuild();
  }

  // ---------- 絞り込み ----------

  const markOf = (card) => state.marks[card.id] || 'none';

  // 出典（例：「R7 午後Ⅰ 問2 ／ R5 午後Ⅰ 問1」）に出てくる試験の一覧
  const examsOf = (card) => (card.meta['出典'] || '').match(/R\d+ 午後[ⅠⅡ]/g) || [];

  function buildOptions() {
    const count = (fn) => state.cards.filter(fn).length;
    const exams = [...new Set(state.cards.flatMap(examsOf))].sort((a, b) =>
      (parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10)) || a.localeCompare(b));
    state.opts.exams = exams.map((e) => ({ value: e, label: e, count: count((c) => examsOf(c).includes(e)) }));
    const noExam = count((c) => !examsOf(c).length);
    if (noExam) state.opts.exams.push({ value: NO_EXAM, label: '年度なし（共通）', count: noExam });
    state.opts.decks = state.decks.map((d) => ({ value: d.file, label: d.title, count: d.cards.length }));
    state.opts.levels = LEVELS.map((l) => ({ value: l, label: l, count: count((c) => c.meta['段階'] === l) }));
    for (const g of Object.keys(GROUPS)) {
      const saved = state.prefs[g];
      const values = state.opts[g].map((o) => o.value);
      state.sel[g] = new Set(saved ? saved.filter((v) => values.includes(v)) : values);
    }
  }

  function matches(card) {
    const { sel } = state;
    if (!sel.decks.has(card.deck.file)) return false;
    if (!sel.levels.has(card.meta['段階'])) return false;
    const ex = examsOf(card);
    if (ex.length ? !ex.some((e) => sel.exams.has(e)) : !sel.exams.has(NO_EXAM)) return false;
    if (state.prefs.status !== 'all' && markOf(card) !== state.prefs.status) return false;
    return true;
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rebuild(keepIndex = false) {
    const filtered = state.cards.filter(matches);
    state.list = state.prefs.shuffle ? shuffled(filtered) : filtered;
    state.index = keepIndex ? Math.min(state.index, Math.max(state.list.length - 1, 0)) : 0;
    state.revealed = false;
    render();
  }

  // ---------- 描画 ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (s) => (window.marked ? window.marked.parse(s, { gfm: true }) : '<pre>' + esc(s) + '</pre>');

  function savePrefs() {
    for (const g of Object.keys(GROUPS)) {
      state.prefs[g] = state.sel[g].size === state.opts[g].length ? null : [...state.sel[g]];
    }
    store.set(PREFS_KEY, state.prefs);
  }

  // 親（全年度など）と子のチェックボックス。親は子が全部選ばれているときだけチェック、一部なら「−」
  function renderFilterGroup(g) {
    const box = $(GROUPS[g].el);
    const sel = state.sel[g];
    const opts = state.opts[g];
    box.innerHTML =
      `<label class="opt opt-all"><input type="checkbox" data-group="${g}" data-all> ${esc(GROUPS[g].all)}</label>` +
      opts.map((o) => `<label class="opt"><input type="checkbox" data-group="${g}" value="${esc(o.value)}"${sel.has(o.value) ? ' checked' : ''}>` +
        ` <span class="opt-label">${esc(o.label)}</span><span class="n">${o.count}</span></label>`).join('');
    const all = box.querySelector('[data-all]');
    all.checked = sel.size === opts.length;
    all.indeterminate = sel.size > 0 && sel.size < opts.length;
  }

  function describe(g) {
    const sel = state.sel[g];
    const opts = state.opts[g];
    if (sel.size === opts.length) return GROUPS[g].all;
    if (!sel.size) return `${GROUPS[g].short}なし`;
    const labels = opts.filter((o) => sel.has(o.value)).map((o) => (o.value === NO_EXAM ? '年度なし' : o.label));
    return labels.length <= 2 ? labels.join('・') : `${GROUPS[g].short}${labels.length}件`;
  }

  function renderControls() {
    const p = state.prefs;
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode)));
    Object.keys(GROUPS).forEach(renderFilterGroup);
    $('#filterDesc').textContent = Object.keys(GROUPS).map(describe).join(' ／ ');
    $('#filters').open = p.filtersOpen;
    $('#statusFilter').value = p.status;
    $('#shuffle').checked = p.shuffle;
  }

  function renderStats() {
    let known = 0, unknown = 0;
    for (const c of state.cards) {
      const m = markOf(c);
      if (m === 'known') known++;
      else if (m === 'unknown') unknown++;
    }
    const none = state.cards.length - known - unknown;
    $('#stats').innerHTML =
      `<span class="known">知ってた <b>${known}</b></span>` +
      `<span class="unknown">知らなかった <b>${unknown}</b></span>` +
      `<span>未判定 <b>${none}</b></span>`;
  }

  function metaHtml(card, { withDeck = true } = {}) {
    const lv = card.meta['段階'];
    const src = card.meta['出典'];
    const mark = markOf(card);
    return `<p class="meta">` +
      (lv ? `<span class="lv lv-${esc(lv)}">【${esc(lv)}】</span>` : '') +
      (withDeck ? `<span>${esc(card.deck.title)}</span>` : '') +
      (src ? `<span>${esc(src)}</span>` : '') +
      (mark === 'known' ? '<span class="done">済：知ってた</span>' : '') +
      (mark === 'unknown' ? '<span class="done unknown">済：知らなかった</span>' : '') +
      `</p>`;
  }

  function honbunHtml(card) {
    const h = card.meta['本文'];
    return h ? `<div class="honbun">本文 <b>${esc(h)}</b> ${esc(HONBUN[h] || '')}</div>` : '';
  }

  // 本文を読まなくても場面がわかるように、問いの前に問題の状況を出す
  function situationHtml(card) {
    const s = card.meta['状況'];
    return s ? `<div class="situation"><p class="situation-label">問題の状況</p><p>${esc(s)}</p></div>` : '';
  }

  const answerHtml = (card) => `<div class="answer"><p class="answer-label">答え</p><div class="md">${md(card.body)}</div></div>`;

  function judgeHtml(card) {
    const m = markOf(card);
    return `<div class="judge">` +
      `<button type="button" class="unknown" data-mark="unknown" data-id="${card.id}" aria-pressed="${m === 'unknown'}">知らなかった</button>` +
      `<button type="button" class="known" data-mark="known" data-id="${card.id}" aria-pressed="${m === 'known'}">知ってた</button>` +
      `</div>`;
  }

  function render() {
    renderStats();
    $('#selCount').innerHTML = `<b>${state.list.length}</b>問 <span>／ ${state.cards.length}</span>`;
    if (!state.list.length) {
      const empty = Object.keys(GROUPS).filter((g) => !state.sel[g].size).map((g) => GROUPS[g].short);
      view.innerHTML = empty.length
        ? `<p class="empty">${empty.join('・')}を1つ以上選んでください。</p>`
        : '<p class="empty">この条件のカードはありません。</p>';
      return;
    }
    if (state.prefs.mode === 'read') renderRead();
    else renderTest();
  }

  function renderTest() {
    const card = state.list[state.index];
    const total = state.list.length;
    const pct = ((state.index + 1) / total) * 100;
    view.innerHTML =
      `<div class="counter"><span>${state.index + 1} / ${total}</span><span class="progress"><i style="width:${pct}%"></i></span></div>` +
      `<article class="card">` +
        metaHtml(card) +
        (card.group ? `<div class="group">${esc(card.group)}</div>` : '') +
        situationHtml(card) +
        `<h2 class="q">${esc(card.q)}</h2>` +
        honbunHtml(card) +
        (state.revealed
          ? answerHtml(card) + judgeHtml(card)
          : `<button type="button" class="reveal" id="reveal">答えを見る</button>`) +
      `</article>` +
      `<div class="nav">` +
        `<button type="button" id="prev" ${state.index === 0 ? 'disabled' : ''}>← 前へ</button>` +
        `<button type="button" id="next" ${state.index >= total - 1 ? 'disabled' : ''}>次へ →</button>` +
      `</div>` +
      `<p class="hint">キーボード：Space 答えを見る ／ 1 知らなかった ／ 2 知ってた ／ ← → 移動</p>`;
  }

  // 読むモード：通常は分野・グループの見出しを付けて並べる。シャッフル中は見出しなしで分野名をバッジで出す
  function renderRead() {
    const shuffle = state.prefs.shuffle;
    let html = shuffle ? '<div class="read-list">' : '';
    let lastDeck = null, lastGroup = null;
    for (const card of state.list) {
      if (!shuffle && card.deck !== lastDeck) {
        if (lastDeck) html += '</div>';
        html += `<h2 class="deck-title">${esc(card.deck.title)}</h2>` +
          (card.deck.intro ? `<p class="deck-intro">${esc(card.deck.intro)}</p>` : '') +
          '<div class="read-list">';
        lastDeck = card.deck; lastGroup = null;
      }
      if (!shuffle && card.group && card.group !== lastGroup) {
        html += `<h3 class="group-title">${esc(card.group)}</h3>`;
        lastGroup = card.group;
      }
      html += `<article class="card">` +
        metaHtml(card, { withDeck: shuffle }) +
        situationHtml(card) +
        `<h3 class="q">${esc(card.q)}</h3>` +
        honbunHtml(card) +
        answerHtml(card) +
        judgeHtml(card) +
        `</article>`;
    }
    html += '</div>';
    view.innerHTML = html;
  }

  // ---------- 操作 ----------

  function setMark(id, mark) {
    if (state.marks[id] === mark) delete state.marks[id];
    else state.marks[id] = mark;
    store.set(MARKS_KEY, state.marks);
  }

  function go(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.list.length) return;
    state.index = next;
    state.revealed = false;
    render();
  }

  function judgeInTest(mark) {
    const card = state.list[state.index];
    if (!card) return;
    setMark(card.id, mark);
    if (!matches(card)) {
      // 「未判定」などで絞り込み中は、判定したカードが一覧から外れる
      state.list = state.list.filter((c) => c !== card);
      state.index = Math.min(state.index, Math.max(state.list.length - 1, 0));
      state.revealed = false;
      render();
    } else if (state.index < state.list.length - 1) {
      go(1);
    } else {
      render();
      toast('最後のカードです');
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  async function copyUnknown() {
    const list = state.cards.filter((c) => markOf(c) === 'unknown');
    if (!list.length) { toast('「知らなかった」のカードはまだありません'); return; }
    const text = `知らなかったカード（${list.length}枚）\n` +
      list.map((c) => `- 【${c.deck.title}】${c.q}` + (c.meta['出典'] ? `（${c.meta['出典']}）` : '')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* 何もしない */ }
      ta.remove();
    }
    toast(`${list.length}枚をコピーしました`);
  }

  document.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.prefs.mode = b.dataset.mode;
    savePrefs();
    renderControls();
    rebuild();
  });

  $('#filters').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-group]');
    if (!input) return;
    const g = input.dataset.group;
    if ('all' in input.dataset) {
      state.sel[g] = input.checked ? new Set(state.opts[g].map((o) => o.value)) : new Set();
    } else if (input.checked) {
      state.sel[g].add(input.value);
    } else {
      state.sel[g].delete(input.value);
    }
    savePrefs(); renderControls(); rebuild();
  });

  $('#filters').addEventListener('toggle', () => {
    state.prefs.filtersOpen = $('#filters').open;
    savePrefs();
  });

  $('#statusFilter').addEventListener('change', (e) => {
    state.prefs.status = e.target.value;
    savePrefs(); rebuild();
  });

  $('#shuffle').addEventListener('change', (e) => {
    state.prefs.shuffle = e.target.checked;
    savePrefs(); rebuild();
  });

  view.addEventListener('click', (e) => {
    if (e.target.closest('#reveal')) { state.revealed = true; render(); return; }
    if (e.target.closest('#prev')) { go(-1); return; }
    if (e.target.closest('#next')) { go(1); return; }
    const jb = e.target.closest('button[data-mark]');
    if (!jb) return;
    if (state.prefs.mode === 'test') {
      judgeInTest(jb.dataset.mark);
    } else {
      setMark(jb.dataset.id, jb.dataset.mark);
      const y = window.scrollY;
      rebuild(true);
      window.scrollTo(0, y);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.prefs.mode !== 'test' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('select, input, textarea')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (!state.revealed && state.list.length) { e.preventDefault(); state.revealed = true; render(); }
    } else if (e.key === 'ArrowRight') { go(1); }
    else if (e.key === 'ArrowLeft') { go(-1); }
    else if (e.key === '1' && state.revealed) { judgeInTest('unknown'); }
    else if (e.key === '2' && state.revealed) { judgeInTest('known'); }
  });

  $('#copyUnknown').addEventListener('click', copyUnknown);
  $('#resetMarks').addEventListener('click', () => {
    if (!confirm('「知ってた／知らなかった」の記録をすべて消します。よろしいですか？')) return;
    state.marks = {};
    store.set(MARKS_KEY, state.marks);
    rebuild();
    toast('記録をリセットしました');
  });

  load();
})();
