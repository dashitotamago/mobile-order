/* 厨房画面(kitchen.html)とホール画面(hall.html)の共通プログラム
 *   厨房:まだ調理していない商品を表示 → 「調理済」でホールへ
 *   ホール:調理済の商品とスタッフ呼び出しを表示 → 「提供済」「対応済」で消える。卓の案内(空席→利用中)もここで行う */
const ROLE = document.body.dataset.role === 'hall' ? 'hall' : 'kitchen';
const CFG = Object.assign({ GAS_URL:'', FIREBASE:null, SHOP_NAME:'お店の名前', POLL_MS:5000, WARN_MIN:10, LATE_MIN:20 }, window.MO_CONFIG || {});
const MODE = CFG.FIREBASE && CFG.FIREBASE.projectId ? 'fb' : CFG.GAS_URL ? 'gas' : 'demo';
const DEMO = MODE === 'demo';
const FBP = MODE === 'fb' ? import('./fb.js') : null;
const fbWhy = e => fetch('fb.js', { cache:'no-store' }).then(r => r.ok ? 'Firebaseの部品を読み込めませんでした(' + String((e && e.message) || e || '').slice(0, 120) + ')' : 'fb.js が見つかりません。GitHubにアップされているか確認してください。').catch(() => '通信できません。Wi-Fiを確認してください。');

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const hm = t => new Date(t).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
const mem = {};
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return k in mem ? mem[k] : d; } },
  set(k, v){ mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const T = ROLE === 'kitchen'
  ? { title:'厨房', done:'調理済', doneMsg:'調理済にしました', count:'未調理', empty:'未調理の注文はありません', emptySub:'新しい注文が入ると、ここに表示されます。' }
  : { title:'ホール', done:'提供済', doneMsg:'提供済にしました', count:'提供待ち', empty:'提供待ちの商品はありません', emptySub:'厨房で「調理済」になった商品と、スタッフ呼び出しがここに表示されます。' };

/* ===== デモ用データ ===== */
const DEMO_CAT = { f01:'名物', f02:'名物', f04:'とりあえず', f07:'刺身', d01:'ビール', d04:'サワー' };
if (DEMO && !store.get('mo_demo_board_seeded', false)) {
  const t = Date.now(), L = (table, orderId, id, name, qty, min, extra) => Object.assign({ lineId:'s' + Math.random().toString(36).slice(2, 9), orderId, at:t - min * 60000, table, id, name, price:500, qty, note:'', call:false, cooked:false, served:false }, extra);
  store.set('mo_demo_orders', [...store.get('mo_demo_orders', []).filter(x => x.id),
    L('3', 'o1', 'f01', '出汁巻き玉子', 1, 12), L('3', 'o1', 'd01', '生ビール', 2, 12, { cooked:true, cookedAt:t - 10 * 60000 }),
    L('5', 'o2', 'f07', '刺身三種盛り', 1, 6), L('5', 'o2', 'd04', 'ハイボール', 1, 6, { note:'氷少なめ' }),
    L('5', 'o3', 'f04', '枝豆', 1, 2), L('3', 'o4', 'f02', '鶏の唐揚げ', 2, 1),
    L('1', 'c1', 'CALL', 'スタッフ呼び出し', 1, 1, { call:true })]);
  store.set('mo_demo_board_seeded', true);
}

/* ===== 通信 ===== */
const demoList = () => store.get('mo_demo_orders', []).filter(x => ROLE === 'kitchen' ? (!x.call && !x.cooked && !x.served) : (!x.served && (x.call || x.cooked)));
const api = DEMO ? {
  async list(){ return { ok:true, now:Date.now(), items:demoList() }; },
  async done(lineId, v){
    const all = store.get('mo_demo_orders', []), x = all.find(i => i.lineId === lineId);
    if (x) { if (ROLE === 'kitchen') { x.cooked = v; x.cookedAt = v ? Date.now() : 0; } else { x.served = v; x.servedAt = v ? Date.now() : 0; } }
    store.set('mo_demo_orders', all); return { ok:true };
  }
} : MODE === 'fb' ? {
  done: async (lineId, v) => ROLE === 'kitchen' ? (await FBP).setCooked(lineId, v) : (await FBP).setServed(lineId, v)
} : {   /* GAS版:厨房の「調理済」は今までの「提供済」と同じ扱い(ホール画面はFirebase版のみ) */
  async list(){ return (await fetch(CFG.GAS_URL + '?action=orders&_=' + Date.now())).json(); },
  async done(lineId, v){
    const r = await fetch(CFG.GAS_URL, { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' }, body:JSON.stringify({ action:'serve', lineId, served:v }) });
    return r.json();
  }
};

/* ===== 状態 ===== */
const PREF = 'mo_board_' + ROLE;
const P = Object.assign({ view:'table', cats:[], items:[], names:{} }, store.get(PREF, {}));
const savePref = () => store.set(PREF, P);
let items = [], known = null, sig = null, offset = 0, last = null, catOf = new Map();
const hide = new Map();    /* 押した直後の行(通信の行き違いで再表示されないように) */
const fresh = new Set();   /* 届いたばかりの行(点滅させる) */
const key = l => l.id && l.id !== 'CALL' ? 'i:' + l.id : 'n:' + l.name;   /* 商品の見分け(IDがない古い注文は名前で) */

function apply(all){
  const now = Date.now(); hide.forEach((v, k) => { if (v < now) hide.delete(k); });
  const list = all.filter(i => !hide.has(i.lineId));
  if (known) {
    const nw = list.filter(i => !known.has(i.lineId));
    if (nw.length) { nw.forEach(i => { fresh.add(i.lineId); setTimeout(() => fresh.delete(i.lineId), 5000); }); beep(nw.some(i => i.call)); }
  }
  known = new Set(list.map(i => i.lineId)); items = list; render();
}
const statOk = t => { $('#stat').className = 'stat'; $('#stat').textContent = t; };
const statNg = t => { $('#stat').className = 'stat off'; $('#stat').textContent = t || '通信できません。Wi-Fiを確認してください'; };
async function poll(){
  try {
    const res = await api.list(); if (!res.ok) throw new Error(res.error);
    offset = (res.now || Date.now()) - Date.now();
    apply(res.items);
    statOk((DEMO ? 'デモ表示中 ' : '') + '更新 ' + new Date().toLocaleTimeString('ja-JP'));
  } catch (e) { statNg(); }
}
function loop(){ poll().finally(() => setTimeout(loop, document.hidden ? 15000 : CFG.POLL_MS)); }

/* ===== 絞り込み ===== */
const catName = l => catOf.get(l.id) || '';
const filtering = () => P.cats.length || P.items.length;
const pass = l => l.call || !filtering() || P.items.includes(key(l)) || P.cats.includes(catName(l));   /* 呼び出しは常に表示 */
function renderFilters(){
  const goods = items.filter(l => !l.call);
  const cats = new Map(), prods = new Map();
  goods.forEach(l => {
    const c = catName(l); if (c) cats.set(c, (cats.get(c) || 0) + l.qty);
    const k = key(l), x = prods.get(k) || { name:l.name, qty:0 }; x.qty += l.qty; prods.set(k, x);
  });
  P.cats.forEach(c => { if (!cats.has(c)) cats.set(c, 0); });   /* 選択中のものは0件でも残す */
  P.items.forEach(k => { if (!prods.has(k)) prods.set(k, { name:P.names[k] || k.slice(2), qty:0 }); });
  const btn = (kind, k, label, n) => `<button class="chip${kind === 'cat' ? ' cat' : ''}" data-f="${kind}" data-k="${esc(k)}" aria-pressed="${(kind === 'cat' ? P.cats : P.items).includes(k)}">${esc(label)}<b>${n}</b></button>`;
  const catHtml = [...cats].sort((a, b) => a[0].localeCompare(b[0], 'ja')).map(([c, n]) => btn('cat', c, c, n)).join('');
  const prodHtml = [...prods].sort((a, b) => b[1].qty - a[1].qty || a[1].name.localeCompare(b[1].name, 'ja')).map(([k, x]) => btn('item', k, x.name, x.qty)).join('');
  $('#filters').innerHTML = `<button class="chip" data-f="all" aria-pressed="${!filtering()}">すべて</button>`
    + (catHtml ? catHtml + '<span class="sep" aria-hidden="true"></span>' : '') + prodHtml;
  $('#filters').hidden = !goods.length && !filtering();
  const hiddenN = goods.filter(l => !pass(l)).reduce((a, l) => a + l.qty, 0);
  $('#filternote').hidden = !filtering();
  $('#filternote').textContent = filtering() ? `絞り込み中:選んだカテゴリ・商品だけを表示しています${hiddenN ? `(ほかに${hiddenN}品あります)` : ''}` : '';
}
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  const f = b.dataset.f, k = b.dataset.k;
  if (f === 'all') { P.cats = []; P.items = []; }
  else {
    const arr = f === 'cat' ? P.cats : P.items, i = arr.indexOf(k);
    if (i >= 0) { arr.splice(i, 1); delete P.names[k]; }
    else { arr.push(k); if (f === 'item') P.names[k] = b.firstChild.textContent; }   /* 0件になっても名前で表示できるよう覚えておく */
  }
  savePref(); sig = null; render();
});

/* ===== 描画 ===== */
const since = l => ROLE === 'hall' && l.cookedAt ? l.cookedAt : l.at;   /* ホールは出来上がってからの時間 */
function lineHtml(i, showTable){
  return `<div class="line${i.call ? ' call' : ''}${fresh.has(i.lineId) ? ' new' : ''}">
    <div class="what"><span class="nm">${esc(i.name)}</span>${i.call ? '' : `<span class="q${i.qty > 1 ? ' many' : ''}">×${i.qty}</span>`}
      ${i.note ? `<span class="memo">${esc(i.note)}</span>` : ''}
      ${showTable ? `<span class="sub">卓 ${esc(i.table)}・${hm(i.at)} 注文</span>` : ''}</div>
    <span class="el" data-at="${since(i)}"></span>
    <button class="done" data-done="${esc(i.lineId)}">${i.call ? '対応済' : T.done}</button>
  </div>`;
}
function render(){
  renderFilters();
  const shown = items.filter(pass).sort((a, b) => a.at - b.at);
  const s = P.view + '|' + shown.map(i => i.lineId + ':' + i.qty + (fresh.has(i.lineId) ? '*' : '')).join('|');
  if (s === sig) return tick();
  sig = s;
  const groups = new Map();
  shown.forEach(i => {
    const g = P.view === 'order' ? (i.call ? 'c:' + i.lineId : 'o:' + (i.orderId || i.lineId)) : 't:' + i.table;
    if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i);
  });
  $('#board').innerHTML = groups.size ? [...groups.values()].map(ls => {
    const goods = ls.filter(i => !i.call), n = goods.reduce((a, i) => a + i.qty, 0);
    const head = P.view === 'order'
      ? `<header><small>卓</small><b>${esc(ls[0].table)}</b><span class="tm">${hm(ls[0].at)}${ls[0].call ? ' 呼び出し' : ' の注文'}</span>${n ? `<span>${n}品</span>` : ''}</header>`
      : `<header><small>卓</small><b>${esc(ls[0].table)}</b>${n ? `<span>${n}品</span>` : ''}</header>`;
    return `<section class="tbl">${head}${ls.map(i => lineHtml(i, false)).join('')}</section>`;
  }).join('') : `<div class="empty"><b>${filtering() ? '選んだ商品の注文はありません' : T.empty}</b>${filtering() ? '「すべて」を押すと、ほかの注文も表示されます。' : T.emptySub}</div>`;
  const goods = items.filter(i => !i.call);
  $('#nItems').textContent = goods.reduce((a, i) => a + i.qty, 0);
  $('#nTables').textContent = new Set(items.map(i => i.table)).size;
  if ($('#nCalls')) $('#nCalls').textContent = items.filter(i => i.call).length;
  document.querySelectorAll('#view button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === P.view));
  tick();
}
function tick(){
  const now = Date.now() + offset;
  document.querySelectorAll('[data-at]').forEach(el => {
    const m = Math.max(0, Math.floor((now - el.dataset.at) / 60000));
    el.textContent = m < 1 ? 'いま' : m + '分';
    el.className = 'el' + (m >= CFG.LATE_MIN ? ' late' : m >= CFG.WARN_MIN ? ' warn' : '');
  });
}
setInterval(tick, 20000);
$('#view').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; P.view = b.dataset.v; savePref(); render(); });

/* ===== 調理済・提供済 / 取り消し ===== */
$('#board').addEventListener('click', e => { const b = e.target.closest('[data-done]'); if (b) done(b.dataset.done); });
function done(id){
  const it = items.find(i => i.lineId === id); if (!it) return;
  hide.set(id, Date.now() + 20000); items = items.filter(i => i.lineId !== id); known && known.delete(id); render();
  it.p = api.done(id, true).then(r => { if (!r.ok) throw new Error(r.error); });
  it.p.catch(() => { if (last === it) last = null; restore(it); snack(`卓${it.table}「${it.name}」を更新できませんでした。もう一度押してください。`); });
  last = it; snack(`卓${it.table}「${it.name}」を${it.call ? '対応済' : T.done}にしました`, true);
}
function restore(it){
  hide.delete(it.lineId); if (!items.some(i => i.lineId === it.lineId)) items.push(it);
  known && known.add(it.lineId); sig = null; render();
}
$('#snackBtn').addEventListener('click', async () => {
  const it = last; last = null; $('#snack').classList.remove('on'); if (!it) return;
  restore(it);
  try { await it.p.catch(() => {}); const r = await api.done(it.lineId, false); if (!r.ok) throw 0; }
  catch (e) { snack('取り消せませんでした。通信状況を確認してください。'); }
});
function snack(text, undo){
  $('#snackText').textContent = text; $('#snackBtn').hidden = !undo; $('#snack').classList.add('on');
  clearTimeout(snack.t); snack.t = setTimeout(() => { $('#snack').classList.remove('on'); if (undo) last = null; }, undo ? 6000 : 4000);
}

/* ===== 卓の案内(ホール・Firebase版) ===== */
let tables = [], armed = null;
function renderTables(){
  if (!$('#tables')) return;
  $('#tables').innerHTML = tables.length ? tables.map(t => `<button class="tcell${t.open ? ' open' : ''}${armed === t.id ? ' armed' : ''}" data-t="${esc(t.id)}">
      <b>${esc(t.name)}</b><span>${t.open ? '利用中' : '空席'}</span>
      <em>${t.open ? (armed === t.id ? 'もう一度押すと空席に' : '押すと空席に戻す') : '押して案内する'}</em></button>`).join('')
    : '<p class="empty" style="padding:30px 0">卓がまだ登録されていません。QRコード作成ページで卓を追加してください。</p>';
  const open = tables.filter(t => t.open).length;
  if ($('#openCount')) $('#openCount').textContent = `${open}/${tables.length}`;
}
if ($('#tablesBtn')) {
  $('#tablesBtn').addEventListener('click', () => { $('#tableSheet').hidden = false; renderTables(); });
  $('#tableSheet').addEventListener('click', async e => {
    if (e.target === $('#tableSheet') || e.target.closest('[data-close]')) { $('#tableSheet').hidden = true; armed = null; return; }
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = tables.find(x => x.id === b.dataset.t); if (!t) return;
    const fb = await FBP;
    try {
      if (!t.open) { await fb.openTable(t.id); snack(`卓${t.name}を案内しました。お客様がQRコードから注文できます。`); }
      else if (armed !== t.id) { armed = t.id; renderTables(); setTimeout(() => { if (armed === t.id) { armed = null; renderTables(); } }, 5000); }
      else { armed = null; await fb.closeTable(t.id); snack(`卓${t.name}を空席に戻しました。この卓からは注文できません。`); }
    } catch (er) { snack('変更できませんでした。通信状況を確認してください。'); }
  });
}

/* ===== 通知音・画面の常時点灯 ===== */
let ac = null;
function beep(isCall){
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  (isCall ? [988, 988, 988] : ROLE === 'hall' ? [880, 1175] : [659, 880]).forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain(), s = t + i * 0.24;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.6, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
    o.connect(g).connect(ac.destination); o.start(s); o.stop(s + 0.24);
  });
}
async function keepAwake(){ try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) {} }
let staff = MODE !== 'fb';
$('#start').addEventListener('click', async () => {
  if (!staff) {   /* Firebase版はスタッフ用アカウントでログイン(この端末では次回から不要) */
    const fb = await FBP, r = await fb.login($('#lgEmail').value, $('#lgPass').value);
    if (!r.ok) { $('#lgErr').hidden = false; $('#lgErr').textContent = r.code === 'login' ? 'メールアドレスかパスワードが違います。' : r.code === 'many' ? '何度も間違えたため一時的にログインできません。少し待ってから試してください。' : 'ログインできませんでした。通信状況を確認してください。'; return; }
  }
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); beep(false); } catch (e) {}
  keepAwake(); $('#gate').hidden = true;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); if (ac) ac.resume(); } });

/* ===== 起動 ===== */
$('#shopName').textContent = CFG.SHOP_NAME + ' ' + T.title; document.title = CFG.SHOP_NAME + ' | ' + T.title;
if (MODE === 'fb') {
  /* Firebase版:注文・調理済が入った瞬間に表示される */
  let off = null, offT = null, offM = null;
  FBP.then(fb => {
    offM = fb.watchMenu(list => { catOf = new Map(list.map(m => [String(m.id), m.cat || ''])); sig = null; if (known) render(); });
    fb.watchStaff(u => {
      staff = !!u; $('#login').hidden = staff;
      $('#start').textContent = staff ? '受付を始める' : 'ログインして受付を始める';
      if (u && !off) {
        off = (ROLE === 'kitchen' ? fb.watchKitchen : fb.watchHall)((list, cached) => { apply(list); cached ? statNg('通信できません。Wi-Fiを確認してください(最後に届いた内容を表示中)') : statOk('リアルタイム受信中'); },
          code => statNg(code === 'permission' ? 'このアカウントでは表示できません。設定を確認してください' : ''));
        if (ROLE === 'hall') offT = fb.watchTables(list => { tables = list; renderTables(); });
      }
      if (!u && off) { off(); off = null; if (offT) { offT(); offT = null; } $('#gate').hidden = false; }
    });
  }).catch(async e => statNg('読み込めませんでした。' + await fbWhy(e)));
} else if (MODE === 'gas' && ROLE === 'hall') {
  statNg('ホール画面はFirebase版でのみ使えます');
  $('#board').innerHTML = '<div class="empty"><b>ホール画面はFirebase版でのみ使えます</b>config.js にFirebaseの設定を入れてください。</div>';
} else {
  if (DEMO) catOf = new Map(Object.entries(DEMO_CAT));
  if ($('#tablesBtn')) $('#tablesBtn').hidden = true;   /* 卓の案内はFirebase版のみ */
  loop();
}
