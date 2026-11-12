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

/* ---------- メニュー ---------- */
function watchMenu(cb, onErr) {
  return F.onSnapshot(MENU, s => cb(s.exists() ? (s.data().list || []) : [], s.metadata.fromCache), e => onErr && onErr(err(e)));
}
async function getMenu() {
  const s = await F.getDoc(MENU);
  return s.exists() ? (s.data().list || []) : [];
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

/* ---------- 注文(お客様) ---------- */
function lineDoc(orderId, i, d) {
  return [F.doc(LINES, orderId + '_' + i), {
    kind: d.kind, orderId, table: d.table, itemId: d.itemId, name: d.name, price: d.price, qty: d.qty, note: d.note || '',
    at: F.serverTimestamp(), uid: auth.currentUser.uid,
    served: false, servedAt: null, paid: d.kind === 'call', paidAt: null, payId: ''
  }];
}
async function placeOrder({ table, orderId, items, menu }) {
  const byId = new Map(menu.map(m => [m.id, m]));
  const unavailable = items.filter(it => { const m = byId.get(it.id); return !m || m.sold || m.hidden; }).map(it => it.id);
  if (unavailable.length) return { ok: false, unavailable };
  try {
    await anon();
    const docs = items.map((it, i) => { const m = byId.get(it.id);
      return lineDoc(orderId, i, { kind: 'item', table, itemId: m.id, name: m.name, price: m.price, qty: it.qty, note: it.note }); });
    for (let i = 0; i < docs.length; i += CHUNK) {
      const part = docs.slice(i, i + CHUNK);
      /* 電波が悪くて送り直したときに二重に登録しない */
      if ((await timeout(F.getDoc(part[0][0]), 8000).catch(() => null))?.exists()) continue;
      const b = F.writeBatch(db);
      part.forEach(([ref, data]) => b.set(ref, data));
      await timeout(b.commit());
    }
    return { ok: true };
  } catch (e) {
    const c = err(e);
    if (c === 'permission') return { ok: false, stale: true, error: 'メニューが更新されたため注文できませんでした。内容を確認して、もう一度「注文を確定する」を押してください。' };
    throw e;
  }
}
async function callStaff(table) {
  await anon();
  const open = await F.getDocs(F.query(LINES, F.where('table', '==', table), F.where('served', '==', false)));
  if (open.docs.some(d => d.data().kind === 'call')) return { ok: true };
  const [ref, data] = lineDoc('c' + rid(), 0, { kind: 'call', table, itemId: 'CALL', name: 'スタッフ呼び出し', price: 0, qty: 1 });
  await timeout(F.setDoc(ref, data));
  return { ok: true };
}

/* ---------- 明細の変換 ---------- */
const BILL_HOURS = 18, PENDING_HOURS = 12;
function toLine(d) {
  const x = d.data({ serverTimestamps: 'estimate' });
  return { lineId: d.id, orderId: x.orderId, at: ms(x.at), table: x.table, id: x.itemId, name: x.name, price: x.price, qty: x.qty,
    note: x.note || '', call: x.kind === 'call', served: !!x.served, paid: !!x.paid };
}
const fresh = (l, h) => Date.now() - l.at < h * 3600e3;

/* お客様の「履歴・会計」 */
async function bill(table) {
  await anon();
  const s = await F.getDocs(F.query(LINES, F.where('table', '==', table), F.where('paid', '==', false)));
  const lines = s.docs.map(toLine).filter(l => !l.call && fresh(l, BILL_HOURS)).sort((a, b) => a.at - b.at);
  return { ok: true, lines, total: lines.reduce((a, l) => a + l.price * l.qty, 0) };
}

/* ---------- 厨房 ---------- */
function watchPending(cb, onErr) {
  return F.onSnapshot(F.query(LINES, F.where('served', '==', false)),
    s => cb(s.docs.map(toLine).filter(l => fresh(l, PENDING_HOURS)), s.metadata.fromCache), e => onErr && onErr(err(e)));
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
async function setPaid(lineIds, paid) {
  const payId = paid ? rid() : '';
  for (let i = 0; i < lineIds.length; i += 400) {
    const b = F.writeBatch(db);
    lineIds.slice(i, i + 400).forEach(id => b.update(F.doc(LINES, id), { paid, paidAt: paid ? F.serverTimestamp() : null, payId }));
    await timeout(b.commit());
  }
  return { ok: true, payId };
}

/* 接続状態(通信が切れているとき画面に出す) */
function watchOnline(cb) {
  const f = () => cb(navigator.onLine);
  addEventListener('online', f); addEventListener('offline', f); f();
}

export { anon, watchStaff, login, logout, resetPass, idToken, staffEmail, watchMenu, getMenu, saveMenu,
  placeOrder, callStaff, bill, watchPending, setServed, watchUnpaid, setPaid, watchOnline, err };
