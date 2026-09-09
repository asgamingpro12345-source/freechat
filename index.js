// MiniPIX 24/7 Telegram quiz bot v3 — CLOUD-READY, SELF-CONTAINED.
// Single-file deployment: bot + Gemini solver + health check server.
// No separate panel needed. Designed for Render / Railway / Koyeb free tiers.
// - Multi-user: each Telegram user owns isolated accounts.
// - Time-slice scheduler: accounts rotate with IP changes via Cloudflare workers.
// - Per-user Gemini API keys (admin uses env pool, users bring their own).
// - JWT login: /addtoken skips OTP flow.
// - Health check on PORT for cloud platforms.
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');

// ---------- env ----------
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (e) { /* no .env — cloud uses env vars directly */ }
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
const BASE = 'https://api.minipix.co/v4/';
const ENV_OWNER = process.env.BOT_OWNER_ID ? Number(process.env.BOT_OWNER_ID) : null;

// ---------- file log ----------
const LOG_PATH = path.join(__dirname, 'bot.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

// ---------- store (per-user accounts) ----------
const ACCT_PATH = path.join(__dirname, 'bot-accounts.json');
let DB = { owner: ENV_OWNER, tickTargetSec: 10, selfUrl: null, users: {} };
try {
  const raw = JSON.parse(fs.readFileSync(ACCT_PATH, 'utf8'));
  DB = { owner: ENV_OWNER ?? raw.owner ?? null, tickTargetSec: raw.tickTargetSec || 10, selfUrl: raw.selfUrl || null, users: raw.users || {} };
  if (raw.accounts && Object.keys(raw.accounts).length) { // v1 flat migration -> owner bucket
    const uid = String(DB.owner || 'legacy');
    DB.users[uid] = DB.users[uid] || { accounts: {} };
    Object.assign(DB.users[uid].accounts, raw.accounts);
    log('migrated', Object.keys(raw.accounts).length, 'legacy accounts to', uid);
  }
} catch (e) { /* fresh */ }
function save() { try { fs.writeFileSync(ACCT_PATH, JSON.stringify(DB, null, 2)); } catch (e) { log('save ERR', e.message); } }
function U(ctx) { const id = String(ctx.from.id); DB.users[id] = DB.users[id] || { accounts: {}, apiKeys: [], sliceMin: 60, sharing: { mode: 'off', accounts: [], hourMin: 60 } }; const u = DB.users[id]; if (!u.sharing) u.sharing = { mode: 'off', accounts: [], hourMin: 60 }; return u; }
function isAdmin(id) { return DB.owner !== null && Number(id) === Number(DB.owner); }
function mask(s) { s = String(s || ''); return s.length <= 8 ? '****' : '****' + s.slice(-4); }

// ---------- knowledge cache ----------
const KNOW_PATH = path.join(__dirname, 'knowledge.json');
let knowledge = {};
try { knowledge = JSON.parse(fs.readFileSync(KNOW_PATH, 'utf8')); } catch (e) { knowledge = {}; }
function saveKnowledge() { try { fs.writeFileSync(KNOW_PATH, JSON.stringify(knowledge)); } catch (e) {} }

// ---------- Gemini solver (inline — no panel needed) ----------
function getGeminiKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
}
let GEMINI_RR = 0;
const GEMINI_KEY_COOLDOWN = new Map();
let GEMINI_COOLDOWN_UNTIL = 0;
async function solveGemini(qEn, qHi, type, topic, options, keysOverride) {
  const GEMINI_KEYS = (Array.isArray(keysOverride) && keysOverride.length ? keysOverride : getGeminiKeys())
    .map(s => String(s).trim()).filter(Boolean);
  if (!GEMINI_KEYS.length) return { index: null, explain: 'no GEMINI_API_KEY(S)' };
  if (Date.now() < GEMINI_COOLDOWN_UNTIL) return { index: null, explain: 'gemini: all keys cooling' };
  const model = 'gemini-3.5-flash-lite';
  const q = qEn || qHi || '';
  const optLines = options.map((o, i) => `${i}) ${o}`).join('\n');
  const prompt = `You answer an English-learning multiple-choice quiz. Reply with ONLY the single digit 0, 1, 2 or 3 of the correct option. No words, no explanation.\nQuestion: ${q}` +
    (qHi && qEn ? `\n(Hindi: ${qHi})` : '') + (type ? `\n(Type: ${type})` : '') + `\nOptions:\n${optLines}`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 128 } });
  let lastErr = 'gemini: no key worked';
  for (let k = 0; k < GEMINI_KEYS.length; k++) {
    const key = GEMINI_KEYS[(GEMINI_RR + k) % GEMINI_KEYS.length];
    if (Date.now() < (GEMINI_KEY_COOLDOWN.get(key) || 0)) continue;
    GEMINI_RR++;
    const tag = `key${(GEMINI_RR % GEMINI_KEYS.length) + 1}/${GEMINI_KEYS.length}`;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = (j && j.error && j.error.message) || ('HTTP ' + r.status);
        lastErr = `gemini(${model},${tag}): ${String(msg).slice(0, 140)}`;
        if (r.status === 429 || r.status === 503 || /quota|demand|overload/i.test(String(msg))) {
          GEMINI_KEY_COOLDOWN.set(key, Date.now() + 90000);
          log('AI', `gemini ${tag} quota hit — cools 90s`);
          continue;
        }
        return { index: null, explain: lastErr };
      }
      const txt = (((j || {}).candidates || [])[0] || {}).content?.parts?.map(p => p.text || '').join('') || '';
      const m = txt.match(/[0-3]/);
      if (m) return { index: parseInt(m[0], 10), explain: `gemini(${model},${tag}) -> ${m[0]}` };
      return { index: null, explain: `gemini(${model},${tag}): no digit in ${txt.slice(0, 80)}` };
    } catch (e) { lastErr = `gemini(${model},${tag}): ${e.message}`; }
    finally { clearTimeout(to); }
  }
  if (GEMINI_KEYS.every(key => Date.now() < (GEMINI_KEY_COOLDOWN.get(key) || 0))) GEMINI_COOLDOWN_UNTIL = Date.now() + 90000;
  return { index: null, explain: lastErr };
}

// ---------- per-account spoofing ----------
const DEV_POOL = [
  ['samsung', 'a53x'], ['samsung', 'dm3q'], ['Xiaomi', 'alioth'], ['Xiaomi', 'sweet'],
  ['vivo', 'V2145'], ['OPPO', 'CPH2451'], ['realme', 'RMX3851'], ['motorola', 'eden'],
  ['Xiaomi', 'garnet'], ['samsung', 'a25x'], ['vivo', 'V2248'], ['OnePlus', 'OP5958L1'],
];
const hex = n => [...require('crypto').randomBytes(n)].map(b => b.toString(16).padStart(2, '0')).join('');
function genFingerprint() {
  const [manufacturer, device] = DEV_POOL[Math.floor(Math.random() * DEV_POOL.length)];
  return { clientId: 'android', deviceId: hex(8), manufacturer, device };
}
const UA = 'okhttp/4.12.0';
const agents = new Map();
function dispatcherFor(acct) {
  if (!acct.proxy) return undefined;
  if (!agents.has(acct.proxy)) {
    try { agents.set(acct.proxy, new ProxyAgent(acct.proxy)); }
    catch (e) { return undefined; }
  }
  return agents.get(acct.proxy);
}

// proxy modes: standard http(s) proxy (undici ProxyAgent) or Cloudflare-Worker
// style (?to=<url> forwarder, see cloudflare-worker-proxy.js)
function proxyMode(acct) {
  if (!acct.proxy) return null;
  try {
    const u = new URL(acct.proxy);
    if (/workers\.dev$/i.test(u.hostname) || u.searchParams.has('to')) return 'worker';
    return 'standard';
  } catch (e) { return null; }
}

// ---------- exit-IP detection + per-turn worker rotation ----------
// Shows the user previous → new IP on every rotation. Works through the
// account's own proxy (worker ?to= / standard proxy / direct).
async function egressIP(proxyUrl) {
  try {
    let url, disp;
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      if (/workers\.dev$/i.test(u.hostname) || u.searchParams.has('to')) {
        const key = u.searchParams.get('key') || '';
        url = u.origin + u.pathname + '?to=' + encodeURIComponent('https://api.ipify.org?format=json') + (key ? '&key=' + encodeURIComponent(key) : '');
      } else { url = 'https://api.ipify.org?format=json'; disp = new ProxyAgent(proxyUrl); }
    } else url = 'https://api.ipify.org?format=json';
    const opts = disp ? { dispatcher: disp } : {};
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => null);
    return (j && j.ip) || null;
  } catch (e) { return null; }
}
async function geoIP(ip) {
  if (!ip) return null;
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=city,countryCode`);
    const j = await r.json().catch(() => null);
    if (j && j.city) return `${j.city}, ${j.countryCode}`;
  } catch (e) {}
  return null;
}
const shortHost = url => { try { return new URL(url).hostname; } catch (e) { return 'direct'; } };
// rotate account to its next worker in pool; returns {url, prevIP, newIP, rotated}
async function rotateWorkerFor(uid, phone) {
  const a = DB.users[uid].accounts[phone];
  const pool = (a.workers || []).filter(Boolean);
  if (!pool.length) return { url: a.proxy || null, prevIP: a.lastIP || null, newIP: a.lastIP || null, rotated: false };
  a.wptr = ((a.wptr || 0) + 1) % pool.length;
  const prevProxy = a.proxy || null, prevIP = a.lastIP || null;
  a.proxy = pool[a.wptr % pool.length];
  const newIP = await egressIP(a.proxy);
  if (newIP) a.lastIP = newIP;
  save();
  return { url: a.proxy, prevIP, newIP: newIP || a.lastIP || null, rotated: a.proxy !== prevProxy };
}

// ---------- MiniPIX API ----------
async function mxFetch(url, method, headers, body, dispatcher) {
  const opts = { method, headers };
  if (dispatcher) opts.dispatcher = dispatcher;
  if (body !== undefined) opts.body = body;
  const r = await fetch(url, opts);
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, ok: r.ok, json, txt };
}
async function mx(method, apiPath, acct, body) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA };
  if (acct && acct.token) headers['Authorization'] = 'Bearer ' + acct.token;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const mode = acct ? proxyMode(acct) : null;
  if (mode === 'worker') {
    // forward through the user's Cloudflare Worker (?to=)
    const u = new URL(acct.proxy);
    const key = u.searchParams.get('key') || '';
    const base = u.origin + u.pathname;
    const url = base + '?to=' + encodeURIComponent(BASE + apiPath) + (key ? '&key=' + encodeURIComponent(key) : '');
    return mxFetch(url, method, headers, payload, undefined);
  }
  const disp = acct ? dispatcherFor(acct) : undefined;
  return mxFetch(BASE + apiPath, method, headers, payload, disp);
}
async function solve(uid, q) {
  // check knowledge cache first
  if (q.questionId && knowledge[q.questionId] && knowledge[q.questionId].aiIndex !== undefined) {
    return { index: knowledge[q.questionId].aiIndex, method: 'cache', cached: true };
  }
  // pick keys: admin uses env pool, users use their own
  const admin = DB.owner !== null && Number(uid) === Number(DB.owner);
  const ukeys = (DB.users[String(uid)] && DB.users[String(uid)].apiKeys) || [];
  const keysToUse = (!admin && ukeys.length) ? ukeys : getGeminiKeys();
  if (!keysToUse.length) {
    if (!admin) { const e = new Error('needs-key'); e.needsKey = true; throw e; }
    return { index: Math.floor(Math.random() * (q.options || [0,0,0,0]).length), method: 'random' };
  }
  const out = await solveGemini(q.questionEn, q.questionHi, q.type, q.topic, q.options || [], keysToUse);
  if (out.index === null || out.index >= (q.options || []).length) {
    return { index: Math.floor(Math.random() * (q.options || [0,0,0,0]).length), method: 'random', explain: out.explain };
  }
  // cache result
  if (q.questionId) {
    knowledge[q.questionId] = { ...(knowledge[q.questionId] || {}), questionEn: q.questionEn, questionHi: q.questionHi,
      options: q.options, aiIndex: out.index, aiMethod: 'gemini', at: new Date().toISOString() };
    saveKnowledge();
  }
  return { index: out.index, method: 'gemini', explain: out.explain };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normPhone = p => { p = String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''); return p.length === 10 ? '+91' + p : null; };
function dayKey(d) { return (d || new Date()).toISOString().slice(0, 10); }
function blankStats() { return { levels: 0, passed: 0, failed: 0, answered: 0, correct: 0, coins: 0, coinsToday: 0, day: dayKey(), lastAt: null, lastResult: null }; }
function touchDay(a) { if (a.stats.day !== dayKey()) { a.stats.day = dayKey(); a.stats.coinsToday = 0; } }

// ---------- global TIME-SLICE scheduler ----------
// One account plays EXCLUSIVELY for its owner's slice (default 60m, /slicetime),
// answering rapidly, then rotation moves to the next account (traffic shifts to
// that account's proxy = IP change). Skips cooling (daily-done) accounts.
let sliceState = null; // { uid, phone, until, startedAt }
let sliceRR = 0;
function orderedRunning() {
  const out = [];
  for (const uid of Object.keys(DB.users).sort()) {
    const u = DB.users[uid];
    for (const phone of Object.keys(u.accounts || {})) {
      const a = u.accounts[phone];
      if (a.running && a.token && !(a.coolingUntil && Date.now() < a.coolingUntil)) out.push({ uid, phone, a });
    }
  }
  return out;
}
function dueAccounts() { return orderedRunning(); }
// per-user turn pointers for fair rotation
const acctPtr = {};
function runningPhones(uid) {
  const u = DB.users[uid];
  if (!u) return [];
  return Object.keys(u.accounts || {}).filter(p => {
    const a = u.accounts[p];
    return a.running && a.token && !(a.coolingUntil && Date.now() < a.coolingUntil);
  });
}
function sharingGroup(uid) {
  const u = DB.users[uid];
  const sh = u && u.sharing;
  if (!sh || sh.mode === 'off') return null;
  const run = runningPhones(uid);
  const group = sh.mode === 'custom' ? (sh.accounts || []).filter(p => run.includes(p)) : run;
  return group.length ? group : null;
}
// next turn for one user: { phone, mins, shared } (advances that user's pointer)
function nextTurnForUser(uid) {
  const u = DB.users[uid];
  if (!u) return null;
  const group = sharingGroup(uid);
  if (group) {
    acctPtr[uid] = ((acctPtr[uid] || 0) + 1) % group.length;
    const phone = group[(acctPtr[uid] - 1 + group.length) % group.length];
    const mins = Math.max(3, Math.round((u.sharing.hourMin || 60) / group.length));
    return { phone, mins, shared: true };
  }
  const run = runningPhones(uid);
  if (!run.length) return null;
  acctPtr[uid] = ((acctPtr[uid] || 0) + 1) % run.length;
  const phone = run[(acctPtr[uid] - 1 + run.length) % run.length];
  return { phone, mins: Math.max(5, Math.min(180, u.sliceMin || 60)), shared: false };
}
async function serveTurn(uid, phone, mins, shared, notify) {
  const a = DB.users[uid].accounts[phone];
  const until = Date.now() + mins * 60000;
  sliceState = { uid, phone, until, startedAt: Date.now(), mins, shared };
  save();
  // fresh IP every turn when the account has a worker pool (sharing/CF auto mode)
  let ipNote = '';
  if ((a.workers || []).length > 1 || (shared && (a.workers || []).length)) {
    try {
      const rot = await rotateWorkerFor(uid, phone);
      const geo = await geoIP(rot.newIP);
      const fmt = ip => ip || '?';
      ipNote = `\n🔀 IP ${fmt(rot.prevIP)} → <b>${fmt(rot.newIP)}</b>${geo ? ` (${geo})` : ''} · via ${shortHost(rot.url)}`;
      log('turn IP', phone, rot.prevIP, '->', rot.newIP);
    } catch (e) { log('IP rotate ERR', phone, e.message); }
  }
  log(shared ? 'share-turn start' : 'slice start', phone, mins + 'm');
  notify(uid, `▶️ <b>${phone}</b> — ${shared ? 'shared turn' : 'exclusive slice'} ${mins}m${ipNote}`, true);
  while (Date.now() < until) {
    const cur = DB.users[uid] && DB.users[uid].accounts[phone];
    if (!cur || !cur.running || !cur.token) break;
    if (cur.coolingUntil && Date.now() < cur.coolingUntil) break;
    let out = null;
    const t0 = Date.now();
    try { out = await stepAccount(uid, phone); }
    catch (e) { log('step ERR', phone, String(e.message).slice(0, 160)); }
    DB.lastStep = { at: new Date().toISOString(), uid, phone, ms: Date.now() - t0, note: out ? 'notified' : 'quiet' };
    if (out) notify(out.uid, out.text);
    const cur2 = DB.users[uid] && DB.users[uid].accounts[phone];
    if (cur2 && cur2.coolingUntil && Date.now() < cur2.coolingUntil) break; // daily-done mid-turn
    await sleep(rnd(1500, 4000)); // breather between steps
  }
  log('turn end', phone);
  if (sliceState && sliceState.phone === phone && sliceState.uid === uid) sliceState = null;
}
let userOrderRR = 0;
async function schedulerLoop(notify) {
  log('scheduler started (slice + sharing mode)');
  while (true) {
    try {
      const uids = Object.keys(DB.users).sort().filter(uid => runningPhones(uid).length > 0);
      if (!uids.length) { sliceState = null; await sleep(10000); continue; }
      userOrderRR = (userOrderRR + 1) % uids.length;
      const uid = uids[userOrderRR % uids.length];
      const turn = nextTurnForUser(uid);
      if (!turn) continue;
      await serveTurn(uid, turn.phone, turn.mins, turn.shared, notify);
    } catch (e) { log('scheduler ERR', e.message); await sleep(5000); }
  }
}
function finishLevel(uid, phone, r) {
  const a = DB.users[uid].accounts[phone];
  if (!a || !r) return null;
  touchDay(a);
  a.stats.levels++;
  if (r.passed) a.stats.passed++; else a.stats.failed++;
  a.stats.coins += (r.coins || 0); a.stats.coinsToday += (r.coins || 0);
  a.stats.lastResult = `L${r.level} ${r.passed ? 'PASS' : 'FAIL'} ${r.correctCount}/${r.questionsCount} (+${r.coins}c)`;
  a.stats.lastAt = new Date().toISOString(); a.q = null; save();
  return `${r.passed ? '🎉' : '😞'} <b>${phone}</b> L${r.level} ${r.passed ? 'PASSED' : 'FAILED'} — ${r.correctCount}/${r.questionsCount} (${r.scorePct}%, need ${r.passPct}%) · +${r.coins}c${r.nextLevel ? ` · next ${r.nextLevel}` : ''}`;
}
const BLOCK_RE = /DAILY|ALL_LEVELS|NO_MORE|POOL|INACTIVE/i;
async function stepAccount(uid, phone) {
  // returns {msg} to notify owner, or null
  const bucket = DB.users[uid];
  const a = bucket && bucket.accounts[phone];
  if (!a || !a.running || !a.token) return null;
  const say = t => ({ uid, text: t });
  let st;
  try { st = await mx('GET', 'quiz/status', a); }
  catch (e) { return say(`⚠️ ${phone}: network (${e.message})`); }
  const sj = st.json || {};
  if (!st.ok || sj.detail === 'Not authenticated') {
    a.running = false; save();
    return say(`❌ ${phone}: token invalid (HTTP ${st.status}) — /addaccount + /verify again`);
  }
  let sessionId = sj.activeSession && sj.activeSession.sessionId;
  if (!sessionId) {
    const s = await mx('POST', 'quiz/session/start', a, {});
    const d = s.json || {};
    if (d.error) {
      if (BLOCK_RE.test(d.error)) { a.coolingUntil = Date.now() + 45 * 60000; save(); return say(`😴 ${phone}: ${d.error} — paused 45m`); }
      return say(`⚠️ ${phone}: start: ${d.error}`);
    }
    sessionId = d.session && d.session.sessionId;
  }
  if (!sessionId) return null;
  a.sessionId = sessionId;
  const cur = await mx('GET', 'quiz/session/current', a);
  const cj = cur.json || {};
  if (cj.result) { const m = finishLevel(uid, phone, cj.result); save(); return m ? say(m) : null; }
  let q = cj.question || (cj.next && cj.next.question);
  if (!q) {
    if (cj.adGate || (cj.next && cj.next.adGate) || (cj.session && cj.session.adGatePending)) {
      const r = await mx('POST', 'quiz/session/ad-ack', a, { sessionId });
      const aj = r.json || {};
      const res = aj.result || (aj.next && aj.next.result);
      if (res) { const m = finishLevel(uid, phone, res); save(); return m ? say(m) : null; }
      q = aj.question || (aj.next && aj.next.question);
      if (!q) return null;
    } else {
      const err = cj.error || (cj.next && cj.next.error) || '';
      if (err && BLOCK_RE.test(err)) { a.coolingUntil = Date.now() + 45 * 60000; save(); return say(`😴 ${phone}: ${err} — paused 45m`); }
      return null;
    }
  }
  // read-time guard: answer only once the question aged past delaySec (spans rotations)
  if (!a.q || a.q.qid !== q.questionId) { a.q = { qid: q.questionId, firstSeen: Date.now() }; save(); return null; }
  if (Date.now() - a.q.firstSeen < (a.delaySec || 5) * 1000) return null;
  let idx = 0;
  try {
    const s = await solve(uid, q);
    if (s.index !== undefined && s.index < (q.options || []).length) idx = s.index;
  } catch (e) {
    if (e.needsKey) {
      if (!a.keyWarned) { a.keyWarned = true; save(); return say(`🔑 ${phone}: link YOUR Gemini key first — /addkey <key> (free: AI Studio → Create API key). Until then answers are random guesses.`); }
      return null;
    }
    log('solve ERR', phone, e.message);
  }
  const ans = await mx('POST', 'quiz/session/answer', a, { sessionId, questionId: q.questionId, chosenIndex: idx });
  const aj = ans.json || {};
  touchDay(a);
  a.stats.answered++;
  if (aj.correct) a.stats.correct++;
  a.stats.coins += (aj.coinsEarned || 0); a.stats.coinsToday += (aj.coinsEarned || 0);
  a.stats.lastAt = new Date().toISOString(); a.q = null; save();
  if (aj.hearts === 0) { try { await mx('POST', 'quiz/lifeline/earn', a, { sessionId }); } catch (e) {} }
  const nx = aj.next || {};
  if (nx.result) { const m = finishLevel(uid, phone, nx.result); save(); return m ? say(m) : null; }
  return null;
}

// ---------- bot ----------
// ---------- telegram layer: self-rolled long-polling on plain fetch ----------
// (Telegraf's launch() hangs opaquely on this machine; raw Bot API works fine.)
const handlers = {};
let polling = false, updateOffset = 0;
const tg = {
  async call(method, params) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) });
    return r.json();
  },
  async getMe() { return (await this.call('getMe')).result; },
  sendMessage(chat, text, extra) {
    log('→', chat, String(text).slice(0, 120).replace(/\s+/g, ' '));
    return this.call('sendMessage', { chat_id: chat, text: String(text), ...(extra || {}) })
      .then(j => { if (!j.ok) log('SEND-FAIL', chat, JSON.stringify(j).slice(0, 200)); return j; });
  },
};
function makeCtx(msg) {
  const chatId = msg.chat.id;
  return {
    from: msg.from, chat: msg.chat, message: msg,
    reply: t => tg.sendMessage(chatId, t),
    replyWithHTML: t => tg.sendMessage(chatId, t, { parse_mode: 'HTML' }),
    deleteMessage: () => tg.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {}),
  };
}
async function freeText(msg) {
  // smart handling: bare numbers AND bare words do the obvious thing (no slash needed)
  const ctx = makeCtx(msg);
  const text = String(msg.text || '').trim();

  // detect raw JWT or Bearer token pasted directly into chat
  const jwtRegex = /(?:bearer\s+)?(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/i;
  const jwtMatch = text.match(jwtRegex);
  if (jwtMatch) {
    const rawToken = jwtMatch[1];
    const words = text.replace(jwtMatch[0], '').trim().split(/\s+/);
    const phoneCandidate = words.map(normPhone).find(Boolean);
    return handleJwtLogin(ctx, phoneCandidate, rawToken);
  }

  const first = text.toLowerCase().split(/\s+/)[0];
  const bare = { start: 'start', help: 'help', run: 'run', stop: 'stop', stats: 'stats', accounts: 'accounts', balance: 'balance', queue: 'queue', status: 'status', ping: 'ping', cancel: 'cancel', jwt: 'jwt', token: 'jwt', hi: 'start', hello: 'start', hey: 'start' };
  if (bare[first] && !/^\d+$/.test(first)) {
    const m2 = { ...msg, text: '/' + bare[first] + text.slice(first.length) };
    return dispatch(m2);
  }
  const digits = text.replace(/\D/g, '');
  const p = pending.get(msg.chat.id);
  if (/^\d{4}$/.test(digits) && p && p.step === 'otp') return doVerify(ctx, digits, p.phone);
  if (/^\+?\d{10,13}$/.test(digits)) {
    const phone = normPhone(digits);
    if (phone) return doAddAccount(ctx, phone);
  }
  if (p && p.step === 'phone') return ctx.reply('Send the 10-digit number, or /cancel.');
  if (digits.length >= 4) return ctx.reply('Tip: type your 10-digit number for OTP, or paste your JWT access token. Commands: /addaccount /jwt /verify /run');
}
async function dispatch(msg) {
  const m = String(msg.text || '').match(/^\/([a-z0-9_]+)(@\S+)?(\s|$)/i);
  if (!m) return freeText(msg);
  const fns = handlers[m[1].toLowerCase()];
  if (!fns) { // did-you-mean
    const want = m[1].toLowerCase();
    const sug = Object.keys(handlers).find(n => n.startsWith(want.slice(0, 4)) || want.includes(n) || n.includes(want));
    return makeCtx(msg).reply(sug ? `Did you mean /${sug}?` : `Unknown command. Try /help`);
  }
  const ctx = makeCtx(msg);
  for (const fn of fns) await fn(ctx, () => {});
}
async function pollLoop() {
  log('polling started');
  while (polling) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 45000);
      let j = null;
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=20&offset=${updateOffset}`, { signal: ctl.signal });
        j = await r.json();
      } finally { clearTimeout(to); }
      for (const u of (j && j.result) || []) {
        updateOffset = Math.max(updateOffset, u.update_id + 1);
        if (u.message && u.message.text) dispatch(u.message).catch(e => log('dispatch ERR', e.message));
      }
    } catch (e) { log('poll ERR', String(e.message).slice(0, 120)); await sleep(3000); }
  }
  log('polling stopped');
}
const bot = {
  telegram: tg,
  command(name, ...fns) { handlers[name] = fns; },
  catch() {},
  stop() { polling = false; },
  async launch() {
    try {
      const j = await tg.call('getUpdates', { timeout: 0, offset: -1 });
      const arr = j.result || [];
      if (arr.length) updateOffset = arr[arr.length - 1].update_id + 1;
      log('flushed', arr.length, 'stale updates');
    } catch (e) { log('flush ERR', e.message); }
    polling = true;
    pollLoop();
  },
};
if (!DB.owner && ENV_OWNER) DB.owner = ENV_OWNER;
const helpUser = `🤖 <b>MiniPIX Quiz Bot</b>
Just <b>type your 10-digit number</b> (for OTP) or paste your <b>JWT token</b> directly.

📱 <b>Accounts & Login</b>
/accounts — list your accounts + state
/jwt — login with JWT access token (skip OTP)
/run /stop — start or stop quiz (phone or "all")
/stats /balance — earnings + coin balance

🔑 <b>AI Keys</b> (required before /run)
/addkey — link your free Gemini API key
/keys /delkey — view or remove keys

⏱️ <b>Rotation</b>
/queue — live rotation: who's playing, time left
/status — scheduler + solver health
/slicetime — set minutes per account (solo mode)
/share /sharehour — split time across accounts

☁️ <b>Proxy & Cloud</b>
/cfsetup — link Cloudflare API → auto-deploy workers
/cfdeploy /cfstatus /cfremove — manage workers
/setproxy /fp /delay — per-account proxy, fingerprint, delay
/worker — download worker script for manual deploy
/keepalive — check auto keep-alive status
/seturl — set app URL for 24/7 keep-alive pings
/backup — backup accounts to Telegram document

/ping — diagnostics · /cancel — abort`;
const helpAdmin = helpUser + `\n\n👑 <b>Admin</b>\n/admin — all users overview\n/users — list users\n/log — last log lines`;
const guard = fn => async ctx => {
  try {
    // mask digit runs (phones/OTPs) before logging
    log('cmd', ctx.from.id, String(ctx.message && ctx.message.text || '').replace(/\d{4,}/g, '****').slice(0, 60));
    if (!DB.owner) { DB.owner = ctx.from.id; save(); ctx.reply('👑 you are the admin (first user).'); }
    await fn(ctx);
  } catch (e) { log('cmd ERR', e.message); try { await ctx.reply('❌ ' + String(e.message).slice(0, 200)); } catch (e2) {} }
};
// conversational state: chatId -> { step: 'phone'|'otp', phone? }
const pending = new Map();

function decodeJwt(token) {
  try {
    const parts = String(token || '').trim().replace(/^Bearer\s+/i, '').split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

async function handleJwtLogin(ctx, phoneArg, tokenArg) {
  const u = U(ctx);
  let token = String(tokenArg || '').trim().replace(/^Bearer\s+/i, '');
  let phone = normPhone(phoneArg);

  // If user swapped phone and token (e.g. /jwt <token> <phone>)
  if (!phone && phoneArg && phoneArg.length > 30 && !token) {
    token = phoneArg.trim().replace(/^Bearer\s+/i, '');
  }

  const jwt = decodeJwt(token);
  if (!jwt && token.length < 20) {
    return ctx.reply('❌ Invalid token format. Provide a valid JWT access token or use /addaccount for OTP login.');
  }

  // Check expiration if exp is present in JWT
  if (jwt && jwt.exp) {
    const expMs = jwt.exp * 1000;
    if (Date.now() > expMs) {
      return ctx.reply(`❌ Token expired on ${new Date(expMs).toUTCString()}.\nPlease obtain a fresh token from the app or login via OTP: /addaccount`);
    }
  }

  // Auto-detect phone if not explicitly provided
  if (!phone && jwt) {
    const p = jwt.phone || jwt.phone_number || jwt.phoneNumber || jwt.mobile;
    if (p) phone = normPhone(p);
  }
  if (!phone) {
    const pendingInfo = pending.get(ctx.chat.id);
    if (pendingInfo && pendingInfo.phone) phone = pendingInfo.phone;
  }
  if (!phone) {
    const existing = Object.keys(u.accounts);
    if (existing.length === 1) phone = existing[0];
  }

  if (!phone) {
    return ctx.replyWithHTML('📱 <b>Which phone number is this token for?</b>\n\nUsage: <code>/jwt 9876543210 ' + mask(token) + '</code>\nOr first send your 10-digit phone number, then send the token.');
  }

  ctx.reply(`⏳ Verifying token for ${phone} with MiniPIX API…`);
  const prev = u.accounts[phone] || {};
  const fp = prev.fingerprint || genFingerprint();
  let balText = '';
  try {
    const r = await mx('GET', 'coins/balance', { token, fingerprint: fp });
    if (r && r.status === 200 && r.json) {
      const coins = r.json.coins ?? r.json.balance ?? r.json.totalCoins ?? 'active';
      balText = `\n🪙 Balance: <b>${coins} coins</b>`;
    } else if (r && r.status === 401) {
      return ctx.reply(`❌ MiniPIX rejected token (HTTP 401 Unauthorized).\nThe token is expired or invalid. Try logging in via OTP: /addaccount ${phone}`);
    } else {
      balText = `\n(API status: HTTP ${r.status})`;
    }
  } catch (e) {
    balText = `\n(Warning: API check had error: ${e.message})`;
  }

  u.accounts[phone] = {
    ...prev,
    phone,
    token,
    userId: (jwt && (jwt.id || jwt.sub || jwt.userId)) || prev.userId || null,
    fingerprint: fp,
    proxy: prev.proxy || null,
    delaySec: prev.delaySec || 5,
    coolingUntil: 0,
    q: null,
    stats: prev.stats || blankStats(),
    running: false
  };
  pending.delete(ctx.chat.id);
  save();

  try { await ctx.deleteMessage(); } catch (e) {}

  ctx.replyWithHTML(`✅ <b>${phone}</b> logged in via JWT! 🔑${mask(token)}${balText}\n\n🚀 Next: <code>/run ${phone.replace('+', '')}</code> (or <code>/run all</code>)\n📊 Check: /accounts or /queue`);
}

async function doAddAccount(ctx, phone) {
  const u = U(ctx);
  phone = normPhone(phone);
  if (!phone) { pending.set(ctx.chat.id, { step: 'phone' }); return ctx.reply('📱 Send me the 10-digit mobile number (just type it).'); }
  ctx.reply('⏳ sending OTP…');
  try {
    const r = await fetch(BASE + 'login/generate-otp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ phone_number: phone }) });
    const j = await r.json();
    if (!j.session_token) return ctx.reply('❌ send failed: ' + JSON.stringify(j).slice(0, 200) + '\nCheck the number and try /addaccount again.');
    const prev = u.accounts[phone] || {};
    u.accounts[phone] = { ...prev, phone, sessionToken: j.session_token, fingerprint: prev.fingerprint || genFingerprint(),
      proxy: prev.proxy || null, delaySec: prev.delaySec || 5, coolingUntil: 0, q: null,
      stats: prev.stats || blankStats(), running: false };
    save();
    pending.set(ctx.chat.id, { step: 'otp', phone });
    const fp = u.accounts[phone].fingerprint;
    ctx.reply(`📩 OTP sent to ${phone}\n📱 device: ${fp.manufacturer}/${fp.device} (saved, reused forever)\n👉 Just type the 4-digit OTP here (or /cancel).`);
  } catch (e) { ctx.reply('❌ network: ' + e.message + ' — try again in a minute.'); }
}
async function doVerify(ctx, otp, phoneMaybe) {
  const u = U(ctx);
  otp = String(otp || '').replace(/\D/g, '');
  if (otp.length !== 4) return ctx.reply('That doesn\'t look like a 4-digit OTP. Try again or /cancel.');
  const p = pending.get(ctx.chat.id);
  const phone = (phoneMaybe && normPhone(phoneMaybe)) || (p && p.phone) ||
    Object.keys(u.accounts).find(x => u.accounts[x].sessionToken && !u.accounts[x].token);
  const a = phone && u.accounts[phone];
  if (!a) return ctx.reply('❌ no pending OTP — start with /addaccount first.');
  ctx.reply('⏳ verifying…');
  const body = { client_id: 'android', device_id: a.fingerprint.deviceId, device_info: a.fingerprint.manufacturer,
    otp, phone_number: phone, session_token: a.sessionToken };
  try {
    const r = await fetch(BASE + 'login/verify-otp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body),
      ...(dispatcherFor(a) ? { dispatcher: dispatcherFor(a) } : {}) });
    const j = await r.json();
    const token = j.access_token || j.accessToken;
    pending.delete(ctx.chat.id);
    if (!token) return ctx.reply('❌ wrong OTP or expired (' + JSON.stringify(j).slice(0, 120) + '). Tap /addaccount to resend.');
    a.token = token; a.userId = j.id || null; delete a.sessionToken; save();
    ctx.replyWithHTML(`✅ <b>${phone}</b> logged in 🔑${mask(token)}\nNext: /run ${phone.replace('+', '')}  ·  see /queue for rotation`);
  } catch (e) { ctx.reply('❌ network: ' + e.message); }
}
const needAdmin = fn => async ctx => {
  if (Number(ctx.from.id) !== Number(DB.owner)) return ctx.reply('⛔ admin only');
  return fn(ctx);
};
bot.command('start', guard(ctx => {
  const u = U(ctx);
  const admin = isAdmin(ctx.from.id);
  const base = admin ? helpAdmin : helpUser;
  const hasAccounts = Object.keys(u.accounts).length > 0;
  const hasKeys = admin || (u.apiKeys || []).length > 0;
  const hasVerified = Object.values(u.accounts).some(a => a.token);
  if (!hasAccounts && !hasKeys)
    return ctx.replyWithHTML(base + `\n\n🚀 <b>Quick start:</b>\n1️⃣ <b>/addkey</b> — get a free key at aistudio.google.com\n2️⃣ Type your <b>10-digit mobile number</b>\n3️⃣ Type the <b>4-digit OTP</b> you receive\n4️⃣ <b>/run</b> — quiz plays 24/7, coins auto-collect`);
  if (!hasKeys)
    return ctx.replyWithHTML(base + `\n\n🔑 <b>Next:</b> /addkey — link your free Gemini key before /run`);
  if (!hasAccounts)
    return ctx.replyWithHTML(base + `\n\n📱 <b>Next:</b> Type your 10-digit number to add an account`);
  if (hasAccounts && !hasVerified)
    return ctx.replyWithHTML(base + `\n\n📩 <b>Next:</b> Type the OTP to verify your account(s)`);
  return ctx.replyWithHTML(base);
}));
bot.command('help', guard(ctx => ctx.replyWithHTML(isAdmin(ctx.from.id) ? helpAdmin : helpUser)));
bot.command('ping', guard(async ctx => {
  const kn = Object.keys(knowledge).length;
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const ka = (DB.selfUrl || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL) ? '🟢' : '⚪';
  ctx.reply(`🏓 alive · running: ${dueAccounts().length} · knowledge: ${kn} · keepalive: ${ka} · mem: ${mem}MB · slice: ${U(ctx).sliceMin || 60}m · ${new Date().toISOString().slice(11, 19)} · uptime: ${Math.round(process.uptime() / 60)}m`);
}));
bot.command('seturl', guard(async ctx => {
  const arg = ctx.message.text.split(/\s+/)[1];
  if (!arg) return ctx.reply(`Usage: /seturl <https://your-app.onrender.com>\nCurrently set: ${DB.selfUrl || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || 'none'}`);
  if (!/^https?:\/\//i.test(arg)) return ctx.reply('❌ URL must start with http:// or https://');
  DB.selfUrl = arg.trim();
  save();
  setupKeepAlive();
  ctx.reply(`✅ Keep-alive URL set to: ${DB.selfUrl}\nBot will ping /health every 9m to prevent cloud sleeping.`);
}));
bot.command('keepalive', guard(async ctx => {
  const target = DB.selfUrl || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || process.env.SELF_URL || null;
  if (!target) return ctx.reply('⚠️ No keep-alive URL configured.\nUse /seturl https://your-app.onrender.com to enable auto-pings.');
  try {
    const pingUrl = target.replace(/\/+$/, '') + '/health';
    const t0 = Date.now();
    const r = await fetch(pingUrl);
    const ms = Date.now() - t0;
    ctx.reply(`🟢 Keep-alive active!\nTarget: ${pingUrl}\nPing test: HTTP ${r.status} (${ms}ms)\nStatus: Auto-pinging every 9 minutes.`);
  } catch (e) {
    ctx.reply(`🔴 Keep-alive ping failed: ${e.message}\nCheck URL with /seturl.`);
  }
}));
bot.command('log', needAdmin(guard(async ctx => {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-15);
    ctx.reply(lines.join('\n').slice(-3500) || '(empty)');
  } catch (e) { ctx.reply('(no log yet)'); }
})));

bot.command('addaccount', guard(async ctx => doAddAccount(ctx, ctx.message.text.split(/\s+/)[1])));
bot.command('jwt', guard(async ctx => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  if (!parts.length) return ctx.reply('Usage:\n/jwt <phone> <jwt_token>\nOr just paste your JWT token directly into chat!');
  if (parts.length === 1) return handleJwtLogin(ctx, null, parts[0]);
  if (normPhone(parts[0])) return handleJwtLogin(ctx, parts[0], parts.slice(1).join(' '));
  if (normPhone(parts[parts.length - 1])) return handleJwtLogin(ctx, parts[parts.length - 1], parts.slice(0, -1).join(' '));
  return handleJwtLogin(ctx, parts[0], parts.slice(1).join(' '));
}));
bot.command('addtoken', guard(async ctx => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  return handleJwtLogin(ctx, parts[0], parts.slice(1).join(' '));
}));
bot.command('token', guard(async ctx => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  return handleJwtLogin(ctx, parts[0], parts.slice(1).join(' '));
}));
bot.command('login', guard(async ctx => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  if (parts.length >= 2 && parts[1].length > 20) return handleJwtLogin(ctx, parts[0], parts.slice(1).join(' '));
  return doAddAccount(ctx, parts[0]);
}));
bot.command('verify', guard(async ctx => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  return doVerify(ctx, args[0], args[1]);
}));
bot.command('cancel', guard(ctx => {
  pending.delete(ctx.chat.id);
  ctx.reply('Cancelled. /addaccount to start over.');
}));
function acctLine(p, a) {
  const s = a.stats;
  return `📱 <b>${p}</b> ${a.token ? '✅' : '⏳otp?'} ${a.running ? '▶️' : '⏹️'}${a.proxy ? ' 🌐' : ''}\n   └ ${a.fingerprint.manufacturer}/${a.fingerprint.device} · ${a.delaySec}s · ${s.passed}P/${s.failed}F · +${s.coins}c (${s.coinsToday} today)${s.lastResult ? ' · ' + s.lastResult : ''}`;
}
bot.command('accounts', guard(ctx => {
  const u = U(ctx), ids = Object.keys(u.accounts);
  if (!ids.length) return ctx.reply('No accounts. /addaccount <phone>');
  ctx.replyWithHTML(ids.map(p => acctLine(p, u.accounts[p])).join('\n'));
}));
bot.command('delaccount', guard(ctx => {
  const u = U(ctx), phone = normPhone(ctx.message.text.split(/\s+/)[1]);
  if (!phone || !u.accounts[phone]) return ctx.reply('Usage: /delaccount <phone>');
  u.accounts[phone].running = false; delete u.accounts[phone]; save();
  ctx.reply(`🗑️ ${phone} removed`);
}));
bot.command('setproxy', guard(ctx => {
  const u = U(ctx);
  const [, ph, url] = ctx.message.text.split(/\s+/);
  const phone = normPhone(ph), a = phone && u.accounts[phone];
  if (!a) return ctx.reply('Usage: /setproxy <phone> <http://user:pass@host:port | off>');
  if (!url || url.toLowerCase() === 'off') a.proxy = null;
  else {
    if (!/^https?:\/\//i.test(url)) return ctx.reply('❌ proxy must start with http:// or https://');
    a.proxy = url;
  }
  save();
  ctx.reply(`🌐 ${phone} proxy ${a.proxy ? 'SET — all its MiniPIX calls exit via this IP' : 'off (your direct IP)'}`);
}));
bot.command('fp', guard(ctx => {
  const u = U(ctx), phone = normPhone(ctx.message.text.split(/\s+/)[1]);
  const a = phone && u.accounts[phone];
  if (!a) return ctx.reply('Usage: /fp <phone>');
  ctx.reply(`📱 ${phone}\nclient: ${a.fingerprint.clientId}\ndevice_id: ${mask(a.fingerprint.deviceId)}\nmanufacturer: ${a.fingerprint.manufacturer}\ndevice: ${a.fingerprint.device}\nproxy: ${a.proxy || 'direct (your IP)'}`);
}));
bot.command('delay', guard(ctx => {
  const u = U(ctx);
  const [, ph, s] = ctx.message.text.split(/\s+/);
  const phone = normPhone(ph), a = phone && u.accounts[phone], sec = Math.max(2, Math.min(20, Number(s) || 0));
  if (!a || !sec) return ctx.reply('Usage: /delay <phone> <2-20>');
  a.delaySec = sec; save();
  ctx.reply(`⏱️ ${phone} read-guard = ${sec}s`);
}));
bot.command('run', guard(async ctx => {
  const u = U(ctx);
  if (!isAdmin(ctx.from.id) && !(u.apiKeys || []).length) {
    return ctx.reply('🔑 API key required before running!\n\n1. Go to aistudio.google.com\n2. Click "Create API key" (free)\n3. Send: /addkey YOUR_KEY\n4. Then /run again\n\nDifferent Cloud projects = separate quotas.\nAdd multiple keys with /addkey for more capacity.');
  }
  const arg = (ctx.message.text.split(/\s+/)[1] || 'all').toLowerCase();
  const ids = arg === 'all' ? Object.keys(u.accounts).filter(p => u.accounts[p].token) : [normPhone(arg)];
  if (!ids.length || !ids[0] || !u.accounts[ids[0]]) return ctx.reply('Usage: /run phone or /run all (verified accounts only)');
  const skipped = Object.keys(u.accounts).filter(p => !u.accounts[p].token);
  for (const p of ids) { u.accounts[p].running = true; u.accounts[p].coolingUntil = 0; u.accounts[p].keyWarned = false; }
  save();
  ctx.reply(`▶️ ${ids.length} account(s) queued — each plays ${u.sliceMin || 60}m slices in rotation${skipped.length ? `\n⏳ skipped (verify OTP first): ${skipped.join(', ')}` : ''}\n📊 /queue to watch · /stats for earnings`);
}));
bot.command('stop', guard(ctx => {
  const u = U(ctx);
  const arg = (ctx.message.text.split(/\s+/)[1] || 'all').toLowerCase();
  if (arg === 'all') { Object.values(u.accounts).forEach(a => { a.running = false; }); save(); return ctx.reply('⏹️ all your runners stopped'); }
  const phone = normPhone(arg);
  if (!phone || !u.accounts[phone]) return ctx.reply('Usage: /stop [phone|all]');
  u.accounts[phone].running = false; save();
  ctx.reply(`⏹️ ${phone} will halt after its current step`);
}));
bot.command('queue', guard(ctx => {
  const uid = String(ctx.from.id);
  const order = orderedRunning();
  if (!order.length) return ctx.reply('Rotation empty — /run to start.');
  const lines = order.map((d, i) => {
    const mine = d.uid === uid;
    const who = mine ? d.phone : `+${'•'.repeat(6)} (user ${d.uid.slice(-4)})`;
    const a = d.a;
    const sh = (DB.users[d.uid].sharing || {}).mode || 'off';
    const mode = sh === 'off' ? `${DB.users[d.uid].sliceMin || 60}m slice` : `share ${Math.round((DB.users[d.uid].sharing.hourMin || 60) / ((sharingGroup(d.uid) || []).length || 1))}m each`;
    const cur = sliceState && sliceState.phone === d.phone && sliceState.uid === d.uid
      ? `▶️ PLAYING · ${Math.max(0, Math.round((sliceState.until - Date.now()) / 60000))}m left`
      : '⏳ waiting';
    const st = a.stats || {};
    const stats = mine ? ` · ${st.answered || 0} ans · +${st.coinsToday || 0}c today` : '';
    const ip = (mine || isAdmin(ctx.from.id)) ? ` · ${a.lastIP || shortHost(a.proxy) || 'direct'}` : '';
    return `${i + 1}. ${who} — ${cur} (${mode})${stats}${ip}`;
  });
  const myCoins = Object.values(DB.users[uid]?.accounts || {}).reduce((s, a) => s + (a.stats?.coinsToday || 0), 0);
  ctx.reply(`🔄 Rotation — ${order.length} running\n\n${lines.join('\n')}\n\n💰 Your coins today: +${myCoins}c`);
}));
bot.command('status', guard(async ctx => {
  const due = dueAccounts().length;
  const last = DB.lastStep ? `${DB.lastStep.phone} ${DB.lastStep.ms}ms (${DB.lastStep.note})` : 'none yet';
  const sl = sliceState ? `${sliceState.phone} (${Math.max(0, Math.round((sliceState.until - Date.now()) / 60000))}m left)` : 'idle';
  const kn = Object.keys(knowledge).length;
  ctx.reply(`🖥️ scheduler alive · solver: inline gemini\nRunning: ${due} · active slice: ${sl}\nKnowledge: ${kn} cached · uptime: ${Math.round(process.uptime() / 60)}m\nLast step: ${last}`);
}));
bot.command('stats', guard(ctx => {
  const u = U(ctx);
  const arg = ctx.message.text.split(/\s+/)[1];
  const ids = arg ? [normPhone(arg)] : Object.keys(u.accounts);
  if (!ids.length || !ids[0] || !u.accounts[ids[0]]) return ctx.reply('Usage: /stats [phone]');
  ctx.replyWithHTML(ids.map(p => {
    const s = u.accounts[p].stats, acc = s.answered ? Math.round(100 * s.correct / s.answered) : 0;
    return `📊 <b>${p}</b> ${u.accounts[p].running ? '▶️' : '⏹️'}\nLevels ${s.levels} (${s.passed}✅/${s.failed}❌) · ${s.correct}/${s.answered} (${acc}%)\nCoins +${s.coins} · +${s.coinsToday} today\nLast: ${s.lastResult || '—'}`;
  }).join('\n\n'));
}));
bot.command('balance', guard(async ctx => {
  const u = U(ctx), phone = normPhone(ctx.message.text.split(/\s+/)[1]);
  const a = phone && u.accounts[phone];
  if (!a || !a.token) return ctx.reply('Usage: /balance <phone>');
  try {
    const r = await mx('GET', 'coins/balance', a);
    ctx.reply(`💰 ${phone}: ${r.json ? (r.json.balance ?? r.json.coins ?? r.json.total ?? JSON.stringify(r.json).slice(0, 120)) : r.txt.slice(0, 120)}`);
  } catch (e) { ctx.reply('❌ ' + e.message); }
}));

// ---- admin ----
bot.command('admin', needAdmin(guard(async ctx => {
  const rows = [];
  for (const [uid, u] of Object.entries(DB.users)) {
    let coins = 0, lv = 0;
    for (const [p, a] of Object.entries(u.accounts || {})) { coins += (a.stats.coins || 0); lv += (a.stats.levels || 0); }
    const n = Object.keys(u.accounts || {}).length;
    const run = Object.values(u.accounts || {}).filter(a => a.running).length;
    rows.push(`👤 ${uid}${Number(uid) === Number(DB.owner) ? ' (admin)' : ''}: ${n} acs (${run} running) · ${lv} levels · +${coins}c`);
    for (const [p, a] of Object.entries(u.accounts || {})) rows.push('   ' + acctLine(p, a).replace(/\n/g, ' '));
  }
  ctx.replyWithHTML(`🛠️ <b>ADMIN</b> · active slice: ${sliceState ? sliceState.phone + ' (' + Math.max(0, Math.round((sliceState.until - Date.now()) / 60000)) + 'm left)' : 'idle'}\n\n` + (rows.join('\n') || '(no users yet)'));
})));
bot.command('users', needAdmin(guard(ctx => {
  ctx.reply(Object.keys(DB.users).map(uid => `👤 ${uid}: ${Object.keys(DB.users[uid].accounts || {}).length} accounts`).join('\n') || '(none)');
})));
bot.command('addkey', guard(async ctx => {
  const u = U(ctx);
  const key = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (key.length < 10) return ctx.reply('Usage: /addkey YOUR_KEY\n\n🔗 Get a free key:\n1. Go to aistudio.google.com\n2. Click "Create API key"\n3. Copy and paste it here\n\nKeys from different Cloud projects = separate quotas.\nAdd multiple keys over time for more capacity.');
  u.apiKeys = u.apiKeys || [];
  if (u.apiKeys.includes(key)) return ctx.reply('⚠️ already linked');
  u.apiKeys.push(key); save();
  try { await ctx.deleteMessage(); } catch (e) {} // don't leave the key in chat
  ctx.reply(`🔑 your key ${mask(key)} linked (${u.apiKeys.length} total). Your accounts now answer with YOUR quota.`);
}));
bot.command('keys', guard(ctx => {
  const u = U(ctx);
  ctx.reply(`🔑 your linked keys: ${((u.apiKeys || []).map(mask).join(', ')) || 'none — /addkey to link'}`);
}));
bot.command('delkey', guard(ctx => {
  const u = U(ctx);
  const n = Number(ctx.message.text.split(/\s+/)[1]);
  if (!n || !(u.apiKeys || [])[n - 1]) return ctx.reply('Usage: /delkey <number from /keys>');
  u.apiKeys.splice(n - 1, 1); save();
  ctx.reply(`🗑️ removed. You have ${(u.apiKeys || []).length} key(s).`);
}));
bot.command('backup', guard(async ctx => {
  const data = JSON.stringify(DB, null, 2);
  const fd = new FormData();
  fd.append('chat_id', String(ctx.chat.id));
  fd.append('document', new Blob([data], { type: 'application/json' }), `minipix-backup-${dayKey()}.json`);
  fd.append('caption', `📦 Backup: ${Object.keys(DB.users).length} users, ${new Date().toISOString()}`);
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  ctx.reply('📦 Backup sent as file above. Save it — cloud storage is ephemeral!');
}));
bot.command('restore', needAdmin(guard(async ctx => {
  ctx.reply('📥 Send me the backup JSON file as a document reply to restore.');
})));
const WORKER_SRC = path.join(__dirname, 'cloudflare-worker-proxy.js');
bot.command('worker', guard(async ctx => {
  ctx.reply('☁️ Worker proxy = free Cloudflare datacenter exit IP.\n1️⃣ dash.cloudflare.com → Workers & Pages → Create → Deploy\n2️⃣ Edit code → paste the file I\'m sending → Save & Deploy\n3️⃣ /setproxy <phone> <worker-url>\nHonest limits: shared CF IP pool (no guaranteed 1:1 per account), 100k req/day, personal use. For guaranteed unique Indian IPs you need paid residential/mobile proxies.');
  try {
    const data = fs.readFileSync(WORKER_SRC);
    const fd = new FormData();
    fd.append('chat_id', String(ctx.chat.id));
    fd.append('document', new Blob([data], { type: 'text/javascript' }), 'minipix-proxy-worker.js');
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  } catch (e) { ctx.reply('❌ could not send file: ' + e.message); }
}));
async function cfCall(u, apiPath, method, body) {
  if (!u.cf || !u.cf.token || !u.cf.accountId) throw new Error('Cloudflare not linked — /cfsetup first');
  const r = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, { method: method || 'GET',
    headers: { 'Authorization': 'Bearer ' + u.cf.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
bot.command('cfsetup', guard(async ctx => {
  const u = U(ctx);
  const [, token, accountId] = ctx.message.text.split(/\s+/);
  if (!token || !accountId || token.length < 10) return ctx.reply('Usage: /cfsetup <api-token> <account-id>\nMake a SCOPED token: dash → Manage Account → API Tokens → Create Custom (Workers Scripts:Edit only). Never use your Global API Key.');
  u.cf = { token, accountId };
  try {
    const j = await cfCall(u, `/accounts/${accountId}/workers/subdomain`);
    if (!j.success) throw new Error(((j.errors || [])[0] && j.errors[0].message) || 'verify failed');
    u.cf.subdomain = j.result.subdomain; save();
    try { await ctx.deleteMessage(); } catch (e) {} // don't leave the token in chat
    ctx.reply(`☁️ Cloudflare linked ✅ (*.${j.result.subdomain}.workers.dev)\nNow: /cfdeploy all — one worker per account, auto-set as its proxy.`);
  } catch (e) { u.cf = null; ctx.reply('❌ Cloudflare rejected it: ' + String(e.message).slice(0, 160)); }
}));
bot.command('cfdeploy', guard(async ctx => {
  const u = U(ctx);
  if (!u.cf) return ctx.reply('/cfsetup first (or /worker for manual deploy).');
  const args = ctx.message.text.split(/\s+/).slice(1);
  const lastIsNum = args.length && /^\d+$/.test(args[args.length - 1]);
  const n = Math.max(1, Math.min(5, lastIsNum ? Number(args.pop()) : 1));
  const arg = (args[0] || 'all').toLowerCase();
  const ids = (arg === 'all' ? Object.keys(u.accounts) : [normPhone(arg)]).filter(p => p && u.accounts[p]);
  if (!ids.length) return ctx.reply('Usage: /cfdeploy [phone|all] [1-5 workers per account]');
  ctx.reply(`⏳ deploying ${n} worker(s) per account…`);
  const res = await ensureWorkers(u, ids, n, t => ctx.reply(t));
  if (!res.ok) return ctx.reply('❌ ' + (res.why || 'deploy failed'));
  ctx.reply('✅ workers ready:\n' + ids.map(p => `${p}: ${(u.accounts[p].workers || []).length} workers, active → ${shortHost(u.accounts[p].proxy)}`).join('\n') + '\nTurns now rotate IPs automatically.');
}));
bot.command('cfstatus', guard(async ctx => {
  const u = U(ctx);
  if (!u.cf) return ctx.reply('Cloudflare not linked. /cfsetup to link, /worker for manual guide.');
  try {
    const j = await cfCall(u, `/accounts/${u.cf.accountId}/workers/scripts`);
    const names = ((j.result || []).map(s => (s && s.id) || s).filter(Boolean));
    const mine = Object.keys(u.accounts).filter(p => (u.accounts[p].proxy || '').includes('workers.dev'));
    ctx.reply(`☁️ ${u.cf.subdomain || ''}\nDeployed here: ${names.slice(0, 20).join(', ') || 'none'}\nYour accounts on workers: ${mine.join(', ') || 'none'}`);
  } catch (e) { ctx.reply('❌ ' + String(e.message).slice(0, 160)); }
}));
bot.command('cfremove', guard(async ctx => {
  const u = U(ctx);
  if (!u.cf) return ctx.reply('/cfsetup first.');
  const arg = (ctx.message.text.split(/\s+/)[1] || 'all').toLowerCase();
  const ids = arg === 'all' ? Object.keys(u.accounts) : [normPhone(arg)];
  for (const p of ids) {
    const a = u.accounts[p];
    const names = new Set();
    for (const w of ((a && a.workers) || [])) {
      try { const h = new URL(w).hostname.split('.')[0]; if (h && h.startsWith('minipix-')) names.add(h); } catch (e) {}
    }
    if (a && a.proxy) { try { const h = new URL(a.proxy).hostname.split('.')[0]; if (h && h.startsWith('minipix-')) names.add(h); } catch (e) {} }
    for (const name of names) { try { await cfCall(u, `/accounts/${u.cf.accountId}/workers/scripts/${name}`, 'DELETE'); } catch (e) {} }
    if (a) { a.workers = []; if ((a.proxy || '').includes('workers.dev')) a.proxy = null; }
  }
  save();
  ctx.reply('🧹 workers removed — affected accounts back to direct IP.');
}));
// ensure each account has n workers (deploy missing via user's Cloudflare)
async function ensureWorkers(u, phones, n, notifyChat) {
  if (!u.cf) return { ok: false, why: 'no-cf' };
  let src = '';
  try { src = fs.readFileSync(WORKER_SRC, 'utf8'); } catch (e) { return { ok: false, why: 'no-src' }; }
  const out = {};
  for (const p of phones) {
    const a = u.accounts[p];
    if (!a) continue;
    a.workers = (a.workers || []).filter(Boolean);
    const need = Math.max(0, n - a.workers.length);
    for (let i = a.workers.length; i < n; i++) {
      const name = 'minipix-' + String(p).replace(/\D/g, '') + '-' + 'abc'[i % 3] + (i >= 3 ? i : '');
      try {
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' })], { type: 'application/json' }));
        fd.append('worker.js', new Blob([src], { type: 'application/javascript+module' }), 'worker.js');
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${u.cf.accountId}/workers/scripts/${name}`,
          { method: 'PUT', headers: { 'Authorization': 'Bearer ' + u.cf.token }, body: fd });
        const j = await r.json();
        if (!j.success) throw new Error(((j.errors || [])[0] && JSON.stringify(j.errors[0]).slice(0, 120)) || 'deploy failed');
        // Enable workers.dev subdomain routing
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${u.cf.accountId}/workers/scripts/${name}/subdomain`,
          { method: 'POST', headers: { 'Authorization': 'Bearer ' + u.cf.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => {});
        a.workers.push(`https://${name}.${u.cf.subdomain}.workers.dev`);
      } catch (e) { if (notifyChat) notifyChat(`❌ worker ${name}: ` + String(e.message).slice(0, 120)); }
    }
    if (!a.proxy && a.workers.length) a.proxy = a.workers[0];
    out[p] = a.workers.length;
  }
  save();
  return { ok: true, out };
}
bot.command('share', guard(async ctx => {
  const u = U(ctx);
  const args = ctx.message.text.split(/\s+/).slice(1);
  const mode = (args[0] || '').toLowerCase();
  if (!mode) {
    const sh = u.sharing || { mode: 'off' };
    const group = sharingGroup(String(ctx.from.id)) || [];
    return ctx.replyWithHTML(`🔗 sharing: <b>${sh.mode}</b> · window ${sh.hourMin || 60}m${sh.mode === 'custom' ? ` · set: ${(sh.accounts || []).join(', ') || 'none'}` : ''}\nActive group now: ${group.join(', ') || 'none'}\nUsage:\n/share all — split 1h across ALL running\n/share custom phone1 phone2 — only these\n/share off`);
  }
  if (mode === 'off') { u.sharing = { mode: 'off', accounts: [], hourMin: (u.sharing || {}).hourMin || 60 }; save(); return ctx.reply('🔗 sharing OFF — back to exclusive slices (/slicetime).'); }
  if (mode === 'all') { u.sharing = { mode: 'all', accounts: [], hourMin: (u.sharing || {}).hourMin || 60 }; }
  else if (mode === 'custom') {
    const picks = args.slice(1).map(normPhone).filter(Boolean);
    if (!picks.length) return ctx.reply('Usage: /share custom <phone1> <phone2>…');
    u.sharing = { mode: 'custom', accounts: picks, hourMin: (u.sharing || {}).hourMin || 60 };
  } else return ctx.reply('Usage: /share all|custom <phones>|off');
  save();
  const group = sharingGroup(String(ctx.from.id)) || [];
  const each = group.length ? Math.round((u.sharing.hourMin || 60) / group.length) : 0;
  let extra = '';
  if (u.cf && group.length) {
    ctx.reply(`⏳ ensuring 3 workers per account for fresh IPs…`);
    await ensureWorkers(u, group, 3, t => ctx.reply(t));
    extra = '\n🌐 3 workers per account — IP rotates every turn, prev→new shown.';
  } else if (!u.cf) extra = '\n⚠️ link Cloudflare (/cfsetup) for automatic fresh IPs per turn — else all turns share your IP.';
  ctx.reply(`🔗 sharing ON (${u.sharing.mode}): ${group.length} account(s) × ~${each}m per hour window, repeating.${extra}\nSee it live: /queue`);
}));
bot.command('sharehour', guard(ctx => {
  const u = U(ctx);
  const m = Math.max(15, Math.min(180, Number(ctx.message.text.split(/\s+/)[1]) || 0));
  if (!m) return ctx.reply(`Usage: /sharehour <15-180> (yours: ${(u.sharing || {}).hourMin || 60}m shared window)`);
  u.sharing = u.sharing || { mode: 'off', accounts: [] };
  u.sharing.hourMin = m; save();
  ctx.reply(`⏱️ shared window = ${m}m (divided across your sharing group).`);
}));
bot.command('slicetime', guard(ctx => {
  const u = U(ctx);
  const m = Math.max(5, Math.min(180, Number(ctx.message.text.split(/\s+/)[1]) || 0));
  if (!m) return ctx.reply(`Usage: /slicetime <minutes 5-180> (yours: ${u.sliceMin || 60}m)\nEach of your accounts plays exclusively for this long, then rotation moves on (and traffic shifts to the next account's IP).`);
  u.sliceMin = m; save();
  ctx.reply(`⏱️ your slice = ${m} min per account. Example: 3 accounts × 20m = full cycle every hour.`);
}));

process.on('unhandledRejection', e => log('unhandledRejection', String((e && e.message) || e).slice(0, 200)));
process.on('uncaughtException', e => log('uncaughtException', String((e && e.message) || e).slice(0, 200)));

// ---------- health check HTTP server (keeps cloud platforms alive) ----------
const http = require('http');
const HEALTH_PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', running: dueAccounts().length, knowledge: Object.keys(knowledge).length, uptime: Math.round(process.uptime()), ts: new Date().toISOString() }));
  } else {
    res.writeHead(404); res.end('not found');
  }
}).listen(HEALTH_PORT, () => {
  log('health check on port', HEALTH_PORT);
  setupKeepAlive();
});

let keepAliveTimer = null;
function setupKeepAlive() {
  const target = DB.selfUrl || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || process.env.SELF_URL || null;
  if (!target) return;
  const pingUrl = target.replace(/\/+$/, '') + '/health';
  log('keepalive ping enabled for', pingUrl);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    try {
      const r = await fetch(pingUrl);
      log('keepalive ping OK', r.status);
    } catch (e) {
      log('keepalive ping ERR', e.message);
    }
  }, 9 * 60 * 1000); // 9 minutes (Render sleeps after 15m)
}

(async () => {
  try {
    const me = await bot.telegram.getMe();
    log('bot token OK as @' + me.username);
  } catch (e) { log('FATAL getMe failed:', e.message); process.exit(1); }
  await bot.launch();
  log('cloud-ready bot started — no panel needed');
  schedulerLoop((uid, text) => bot.telegram.sendMessage(uid, text, { parse_mode: 'HTML' }).catch(e => log('notify ERR', e.message)));
})();
process.once('SIGINT', () => { save(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { save(); bot.stop('SIGTERM'); });
