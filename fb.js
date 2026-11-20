/* モバイルオーダー Firebase 接続部分(注文・厨房・会計・管理の4画面で共通)
 * config.js に FIREBASE が設定されているときだけ読み込まれます。 */
const V = '13.3.0';
const SDK = 'https://www.gstatic.com/firebasejs/' + V + '/';
const [{ initializeApp }, A, F] = await Promise.all([
  import(SDK + 'firebase-app.js'),
  import(SDK + 'firebase-auth.js'),
  import(SDK + 'firebase-firestore.js')
]);

const CFG = window.MO_CONFIG || {};
const app = initializeApp(CFG.FIREBASE);
const auth = A.getAuth(app);
let db;
try {   /* 端末に保存して、2回目以降はすぐ表示する */
  db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
} catch (e) {
  db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });
}

const LINES = F.collection(db, 'lines');
const MENU = F.doc(db, 'config', 'menu');
const MENU_PREV = F.doc(db, 'config', 'menu_prev');
const TABLES = F.collection(db, 'tables');
const CHUNK = 10;   /* 1回の書き込みで送る明細の数(セキュリティルールの照合回数の上限に合わせる) */

/* 電波が切れていると書き込みの完了を待ち続けてしまうので、一定時間で「通信できない」扱いにする
   (書き込み自体は端末に残り、電波が戻ると自動で送られる) */
const timeout = (p, t = 15000) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng({ code: 'unavailable' }), t))]);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v ? Number(v) : Date.now());
const err = e => {
  const c = (e && e.code) || '';
  if (c.includes('permission-denied')) return 'permission';
  if (c.includes('unavailable') || c.includes('deadline') || c.includes('network')) return 'network';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found') || c.includes('invalid-email')) return 'login';
  if (c.includes('too-many-requests')) return 'many';
  return c || 'unknown';
};

/* ---------- ログイン ---------- */
const authReady = new Promise(ok => { const off = A.onAuthStateChanged(auth, () => { off(); ok(); }); });
async function anon() {   /* お客様は自動で匿名ログイン(誰の注文かを区別するため) */
  await authReady;
  if (!auth.currentUser) await A.signInAnonymously(auth);
  return auth.currentUser;
}
function watchStaff(cb) {
  return A.onAuthStateChanged(auth, u => cb(u && !u.isAnonymous ? { email: u.email } : null));
}
async function login(email, pass) {
  try { await A.signInWithEmailAndPassword(auth, String(email).trim(), pass); return { ok: true }; }
  catch (e) { return { ok: false, code: err(e) }; }
}
const logout = () => A.signOut(auth);
async function resetPass(email) {
  try { await A.sendPasswordResetEmail(auth, String(email).trim()); return { ok: true }; }
  catch (e) { return { ok: false, code: err(e) }; }
}
async function idToken() { await authReady; return auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.getIdToken() : ''; }
const staffEmail = () => auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.email : '';

/* ---------- LINEログイン・顧客情報 ----------
 * お客様はLINEでログインし、GASが確認して発行した鍵(カスタムトークン)でFirebaseにログインする。
 * 顧客情報は customers/{お客様ID} に保存し、本人とスタッフだけが読める。 */
const CUSTOMERS = F.collection(db, 'customers');
async function signInLine(token) { await authReady; const c = await A.signInWithCustomToken(auth, token); return c.user.uid; }
const myUid = () => auth.currentUser ? auth.currentUser.uid : '';
const isLineUser = () => !!auth.currentUser && /^line_/.test(auth.currentUser.uid);
async function getCustomer(uid) { const s = await timeout(F.getDoc(F.doc(CUSTOMERS, uid))); return s.exists() ? s.data() : null; }
async function createCustomer(uid, data) {
  await timeout(F.setDoc(F.doc(CUSTOMERS, uid), { ...data, visits: 0, spent: 0, lastSession: '', lastVisitAt: null, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() }));
  return { ok: true };
}
async function updateProfile(uid, data) { await timeout(F.updateDoc(F.doc(CUSTOMERS, uid), { ...data, updatedAt: F.serverTimestamp() })); return { ok: true }; }
/* 注文のたびに呼ぶ:来店(卓の区切り)が新しければ来店回数を1増やし、注文額を足す */
async function recordOrder(uid, { session, amount }) {
  const ref = F.doc(CUSTOMERS, uid), cur = await F.getDoc(ref).catch(() => null);
  if (!cur || !cur.exists()) return;
  const d = { spent: F.increment(Math.max(0, Math.round(amount) || 0)), updatedAt: F.serverTimestamp() };
  if (cur.data().lastSession !== session) Object.assign(d, { visits: F.increment(1), lastSession: session, lastVisitAt: F.serverTimestamp() });
  await timeout(F.updateDoc(ref, d)).catch(() => {});
}
function watchCustomers(cb, onErr) {
  return F.onSnapshot(CUSTOMERS, s => cb(s.docs.map(d => { const x = d.data({ serverTimestamps: 'estimate' });
    return { uid: d.id, ...x, createdAt: x.createdAt ? ms(x.createdAt) : 0, lastVisitAt: x.lastVisitAt ? ms(x.lastVisitAt) : 0, consentAt: x.consentAt ? ms(x.consentAt) : 0 }; })),
    e => onErr && onErr(err(e)));
}
/* ある顧客の注文明細(よく頼む商品を出すため) */
async function customerLines(uid) {
  const s = await timeout(F.getDocs(F.query(LINES, F.where('uid', '==', uid))), 20000);
  return s.docs.map(toLine).filter(l => !l.call && !l.seat);
}

/* ---------- メニュー ---------- */
function watchMenu(cb, onErr) {
  return F.onSnapshot(MENU, s => cb(s.exists() ? (s.data().list || []) : [], s.metadata.fromCache), e => onErr && onErr(err(e)));
}
async function getMenu() {
  const s = await F.getDoc(MENU);
  return s.exists() ? (s.data().list || []) : [];
}
/* 1品の売り切れを切り替える(会計画面から)。同時に他の端末が保存しても消えないよう、最新のメニューを読んでから書く */
async function setSold(id, sold) {
  await timeout(F.runTransaction(db, async tx => {
    const s = await tx.get(MENU); if (!s.exists()) throw new Error('メニューがありません');
    const list = (s.data().list || []).map(m => m.id === id ? { ...m, sold } : m);
    const p = {}; list.forEach(m => { p[m.id] = { n: m.name, pr: m.price, ok: !m.sold && !m.hidden }; });
    tx.set(MENU, { ...s.data(), list, p, updatedAt: F.serverTimestamp(), updatedBy: staffEmail() });
  }));
  return { ok: true };
}
async function saveMenu(list) {
  const p = {};
  list.forEach(m => { p[m.id] = { n: m.name, pr: m.price, ok: !m.sold && !m.hidden }; });
  const old = await F.getDoc(MENU);
  const b = F.writeBatch(db);
  if (old.exists()) b.set(MENU_PREV, { ...old.data(), savedAt: F.serverTimestamp() });   /* 直前の内容を控えておく */
  b.set(MENU, { list, p, updatedAt: F.serverTimestamp(), updatedBy: staffEmail() });
  await timeout(b.commit());
  return { ok: true, count: list.length };
}

/* ---------- 卓(QRコード) ----------
 * 卓ごとに固定のIDを持ち、QRコードはそのIDを指す(一度作ったQRはずっと使える)。
 * 卓には「来店ごとの区切り(session)」があり、会計済にすると新しい区切りに切り替わる。
 * 注文は今の区切りに対してだけ受け付けるので、会計後に前のお客様の画面から注文が入ることはない。 */
const tableId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
function watchTable(id, cb, onErr) {
  return F.onSnapshot(F.doc(TABLES, id), s => cb(s.exists() ? { id, name: s.data().name, session: s.data().session, open: s.data().open === true } : null, s.metadata.fromCache),
    e => onErr && onErr(err(e)));
}
function watchTables(cb, onErr) {
  return F.onSnapshot(TABLES, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'ja', { numeric: true }))),
    e => onErr && onErr(err(e)));
}
async function addTable(name, order) {
  const id = tableId();
  await timeout(F.setDoc(F.doc(TABLES, id), { name, order, session: rid(), open: false, createdAt: F.serverTimestamp() }));
  return { ok: true, id };
}
async function deleteTable(id) { await timeout(F.deleteDoc(F.doc(TABLES, id))); return { ok: true }; }
async function renameTable(id, name) { await timeout(F.updateDoc(F.doc(TABLES, id), { name })); return { ok: true }; }
/* 卓を案内する(利用中にして、新しい来店の区切りを作る)/閉じる(空席に戻して注文を止める) */
async function openTable(id) { await timeout(F.updateDoc(F.doc(TABLES, id), { open: true, session: rid(), openedAt: F.serverTimestamp() })); return { ok: true }; }
async function closeTable(id) { await timeout(F.updateDoc(F.doc(TABLES, id), { open: false, session: rid() })); return { ok: true }; }

/* ---------- 注文(お客様) ---------- */
function lineDoc(orderId, i, d) {
  return [F.doc(LINES, orderId + '_' + i), {
    kind: d.kind, orderId, table: d.table, tableId: d.tableId, session: d.session, itemId: d.itemId, name: d.name, price: d.price, qty: d.qty, note: d.note || '',
    at: F.serverTimestamp(), uid: auth.currentUser.uid,
    /* 席料は厨房・ホールに出さないので、最初から調理済・提供済にしておく */
    cooked: d.kind === 'seat', cookedAt: null, served: d.kind === 'seat', servedAt: null, paid: d.kind === 'call', paidAt: null, payId: ''
  }];
}

/* ---------- スタッフが入力する注文(口頭で聞いた注文・席料) ----------
 * 空席の卓なら、案内(利用中)にしてから入力する。注文はお客様のスマホからの注文と同じく厨房に表示される。 */
async function staffOrder({ tableId, items = [], seat = null, menu = [] }) {
  const ref = F.doc(TABLES, tableId);
  let t = await timeout(F.getDoc(ref));
  if (!t.exists()) return { ok: false, error: 'この卓は登録されていません。' };
  let opened = false;
  if (t.data().open !== true) { await openTable(tableId); t = await timeout(F.getDoc(ref)); opened = true; }
  const { name: table, session } = t.data();
  const byId = new Map(menu.map(m => [m.id, m]));
  const orderId = 's' + rid().replace(/[^A-Za-z0-9]/g, '');
  const docs = [];
  items.forEach(it => { const m = byId.get(it.id); if (!m) return;
    docs.push(lineDoc(orderId, docs.length, { kind: 'item', table, tableId, session, itemId: m.id, name: m.name, price: m.price, qty: it.qty, note: it.note || '' })); });
  if (seat && seat.qty > 0) docs.push(lineDoc(orderId, docs.length, { kind: 'seat', table, tableId, session, itemId: 'SEAT', name: '席料', price: seat.price, qty: seat.qty }));
  if (!docs.length) return { ok: false, error: '入力された商品がありません。' };
  for (let i = 0; i < docs.length; i += CHUNK) {
    const b = F.writeBatch(db);
    docs.slice(i, i + CHUNK).forEach(([r, data]) => b.set(r, data));
    await timeout(b.commit());
  }
  return { ok: true, table, opened, count: docs.length };
}
/* お店の設定(席料の単価など)。スタッフだけが読み書きできる */
const SETTINGS = F.doc(db, 'config', 'settings');
async function getSettings() { const s = await timeout(F.getDoc(SETTINGS)).catch(() => null); return s && s.exists() ? s.data() : {}; }
async function saveSettings(data) { await timeout(F.setDoc(SETTINGS, data, { merge: true })); return { ok: true }; }
async function placeOrder({ table, tableId, session, orderId, items, menu, retry }) {
  const byId = new Map(menu.map(m => [m.id, m]));
  const unavailable = items.filter(it => { const m = byId.get(it.id); return !m || m.sold || m.hidden; }).map(it => it.id);
  if (unavailable.length) return { ok: false, unavailable };
  try {
    await anon();
    const docs = items.map((it, i) => { const m = byId.get(it.id);
      return lineDoc(orderId, i, { kind: 'item', table, tableId, session, itemId: m.id, name: m.name, price: m.price, qty: it.qty, note: it.note }); });
    for (let i = 0; i < docs.length; i += CHUNK) {
      const part = docs.slice(i, i + CHUNK);
      /* 送り直しのときだけ、前回の分が届いていないか確かめる(二重登録の防止)。通常の注文では確認を省いて速く送る */
      if (retry && (await timeout(F.getDoc(part[0][0]), 8000).catch(() => null))?.exists()) continue;
      const b = F.writeBatch(db);
      part.forEach(([ref, data]) => b.set(ref, data));
      await timeout(b.commit());
    }
    return { ok: true };
  } catch (e) {
    const c = err(e);
    if (c === 'permission') {
      /* 会計が済んで区切りが変わっていたら(または空席になっていたら)、その旨を返す */
      const t = await F.getDoc(F.doc(TABLES, tableId)).catch(() => null);
      if (t && (!t.exists() || t.data().session !== session || t.data().open !== true)) return { ok: false, ended: true };
      return { ok: false, stale: true, error: 'メニューが更新されたため注文できませんでした。内容を確認して、もう一度「注文を確定する」を押してください。' };
    }
    throw e;
  }
}
async function callStaff({ table, tableId, session }) {
  await anon();
  const open = await F.getDocs(F.query(LINES, F.where('tableId', '==', tableId), F.where('served', '==', false)));
  if (open.docs.some(d => d.data().kind === 'call')) return { ok: true };
  const [ref, data] = lineDoc('c' + rid(), 0, { kind: 'call', table, tableId, session, itemId: 'CALL', name: 'スタッフ呼び出し', price: 0, qty: 1 });
  try { await timeout(F.setDoc(ref, data)); }
  catch (e) { if (err(e) === 'permission') return { ok: false, ended: true }; throw e; }
  return { ok: true };
}

/* ---------- 明細の変換 ---------- */
const BILL_HOURS = 18, PENDING_HOURS = 12;
function toLine(d) {
  const x = d.data({ serverTimestamps: 'estimate' });
  return { lineId: d.id, orderId: x.orderId, at: ms(x.at), table: x.table, tableId: x.tableId || '', session: x.session || '', id: x.itemId, name: x.name, price: x.price, qty: x.qty,
    note: x.note || '', call: x.kind === 'call', seat: x.kind === 'seat', cooked: !!x.cooked, cookedAt: x.cookedAt ? ms(x.cookedAt) : 0,
    served: !!x.served, servedAt: x.servedAt ? ms(x.servedAt) : 0, paid: !!x.paid, payId: x.payId || '' };
}
const fresh = (l, h) => Date.now() - l.at < h * 3600e3;

/* お客様の「履歴・会計」(今の来店の区切りの分だけ) */
async function bill({ tableId, session }) {
  await anon();
  const s = await F.getDocs(F.query(LINES, F.where('tableId', '==', tableId), F.where('session', '==', session)));
  const lines = s.docs.map(toLine).filter(l => !l.call && fresh(l, BILL_HOURS)).sort((a, b) => a.at - b.at);
  return { ok: true, lines, total: lines.reduce((a, l) => a + l.price * l.qty, 0) };
}

/* ---------- 厨房 ---------- */
function watchPending(cb, onErr) {
  return F.onSnapshot(F.query(LINES, F.where('served', '==', false)),
    s => cb(s.docs.map(toLine).filter(l => fresh(l, PENDING_HOURS)), s.metadata.fromCache), e => onErr && onErr(err(e)));
}
/* 厨房:まだ調理済にしていない商品 */
function watchKitchen(cb, onErr) {
  return F.onSnapshot(F.query(LINES, F.where('cooked', '==', false)),
    s => cb(s.docs.map(toLine).filter(l => !l.call && !l.served && fresh(l, PENDING_HOURS)), s.metadata.fromCache), e => onErr && onErr(err(e)));
}
/* ホール:調理済でまだ提供していない商品と、スタッフ呼び出し */
function watchHall(cb, onErr) {
  return F.onSnapshot(F.query(LINES, F.where('served', '==', false)),
    s => cb(s.docs.map(toLine).filter(l => (l.call || l.cooked) && fresh(l, PENDING_HOURS)), s.metadata.fromCache), e => onErr && onErr(err(e)));
}
async function setCooked(lineId, cooked) {
  await timeout(F.updateDoc(F.doc(LINES, lineId), { cooked, cookedAt: cooked ? F.serverTimestamp() : null }));
  return { ok: true };
}
async function setServed(lineId, served) {
  await timeout(F.updateDoc(F.doc(LINES, lineId), { served, servedAt: served ? F.serverTimestamp() : null }));
  return { ok: true };
}

/* ---------- 会計 ---------- */
function watchUnpaid(cb, onErr) {
  return F.onSnapshot(F.query(LINES, F.where('paid', '==', false)),
    s => cb(s.docs.map(toLine).filter(l => !l.call && fresh(l, BILL_HOURS)), s.metadata.fromCache), e => onErr && onErr(err(e)));
}
/* 会計済にする/戻す。sessions に [{id, session}] を渡すと、その卓の区切りも同時に切り替える
   (会計済:新しい区切りにして、前のお客様の画面から注文できなくする / 取り消し:元の区切りに戻す) */
async function setPaid(lineIds, paid, sessions = []) {
  const payId = paid ? rid() : '';
  for (let i = 0; i < lineIds.length || (i === 0 && sessions.length); i += 400) {
    const b = F.writeBatch(db);
    lineIds.slice(i, i + 400).forEach(id => b.update(F.doc(LINES, id), { paid, paidAt: paid ? F.serverTimestamp() : null, payId }));
    if (i === 0) sessions.forEach(t => b.update(F.doc(TABLES, t.id), { session: t.session, open: t.open === true }));
    await timeout(b.commit());
  }
  return { ok: true, payId };
}
const newSession = rid;

/* ---------- 商品分析 ---------- */
/* 指定期間(ミリ秒)の注文明細を取得する。呼び出しは除く */
async function getLines(from, to) {
  const s = await timeout(F.getDocs(F.query(LINES,
    F.where('at', '>=', F.Timestamp.fromMillis(from)), F.where('at', '<', F.Timestamp.fromMillis(to)))), 30000);
  return s.docs.map(toLine).filter(l => !l.call);
}

/* 接続状態(通信が切れているとき画面に出す) */
function watchOnline(cb) {
  const f = () => cb(navigator.onLine);
  addEventListener('online', f); addEventListener('offline', f); f();
}

export { anon, watchStaff, login, logout, resetPass, idToken, staffEmail, watchMenu, getMenu, saveMenu,
  watchTable, watchTables, addTable, deleteTable, renameTable, openTable, closeTable, newSession, watchKitchen, watchHall, setCooked,
  staffOrder, getSettings, saveSettings, setSold,
  signInLine, myUid, isLineUser, getCustomer, createCustomer, updateProfile, recordOrder, watchCustomers, customerLines,
  placeOrder, callStaff, bill, watchPending, setServed, watchUnpaid, setPaid, getLines, watchOnline, err };
