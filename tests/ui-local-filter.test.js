const vm = require('vm'), fs = require('fs'), assert = require('assert');
const dir = __dirname + '/../extension/';

const els = {};
const mk = () => ({
  value: '', hidden: false, textContent: '', disabled: false, className: '', onclick: null,
  classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, replaceChildren() {},
  createTHead() { return { insertRow() { return { appendChild() {} }; } }; },
  createTBody() { return { insertRow() { return { insertCell() { return {}; } }; } }; }
});
const root = { set innerHTML(_) {}, querySelector(sel) { return els[sel] || (els[sel] = mk()); } };
const hostEl = { attachShadow() { return root; } };

let planToReturn;
const calls = [];
const TOTAL_PAGES = 3;
// every 4th user has no country code (missing), every 7th has an empty string, the rest PT/ES
const mkUser = (n, i) => {
  const k = n * 200 + i; const profile = { login: `u${k}` };
  if (k % 4 === 0) { /* missing */ } else if (k % 7 === 0) profile.countryCode = ''; else profile.countryCode = k % 2 ? 'PT' : 'ES';
  return { id: `u${k}`, status: 'ACTIVE', profile };
};
const page = n => Array.from({ length: 200 }, (_, i) => mkUser(n, i));
const expectedEmpty = Array.from({ length: 600 }, (_, k) => mkUser(Math.floor(k / 200), k % 200)).filter(u => !u.profile.countryCode).length;
const expectedNotPT = Array.from({ length: 600 }, (_, k) => mkUser(Math.floor(k / 200), k % 200)).filter(u => (u.profile.countryCode || '').toLowerCase() !== 'pt').length;
const ctx = {
  window: null, console, URL, URLSearchParams, AbortController, Blob, setTimeout, Date, Number, JSON, Object, Array, Math, Promise, Error,
  location: { hostname: 'acme-admin.okta.com', origin: 'https://acme-admin.okta.com' },
  document: { getElementById: () => null, documentElement: { appendChild() {} }, createElement: () => hostEl },
  chrome: { runtime: { id: 'abc', sendMessage: async () => ({ ok: true, plan: planToReturn }) } },
  fetch: async (url, opts) => {
    calls.push({ url });
    const n = Number((url.match(/after=(\d+)/) || [0, 0])[1]);
    const next = n + 1 < TOTAL_PAGES ? `<https://acme.okta.com/api/v1/users?after=${n + 1}&limit=200>; rel="next"` : null;
    return { status: 200, ok: true, headers: { get: h => (h.toLowerCase() === 'link' ? next : null) }, json: async () => page(n) };
  }
};
ctx.window = ctx; ctx.window.top = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'lib.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8'), ctx);

(async () => {
  // 1) "users with country code empty": request is broad, filtering happens locally
  planToReturn = { request: '/api/v1/users', local_filter: [{ path: 'profile.countryCode', op: 'empty' }], columns: ['id', 'profile.countryCode'], summary: 'Users with no country code (filtered in the browser).', clarification: null };
  els['#prompt'].value = 'list of users with country code empty';
  await els['#translate'].onclick();
  assert.strictEqual(els['#local'].hidden, false);
  assert.strictEqual(els['#local'].textContent, 'Then filtered in your browser: profile.countryCode is empty');
  assert.strictEqual(els['#expr'].value, '/api/v1/users');
  await els['#run'].onclick();
  assert.strictEqual(calls.length, TOTAL_PAGES);
  assert(els['#status'].textContent.startsWith(`${expectedEmpty} matching rows (scanned 600 in 3 pages)`), els['#status'].textContent);
  console.log('EMPTY FILTER OK:', els['#status'].textContent);

  // 2) "not in Portugal" with a narrowing server-side part + local ne (empty users included)
  calls.length = 0;
  planToReturn = { request: '/api/v1/users?search=status eq "ACTIVE"', local_filter: [{ path: 'profile.countryCode', op: 'ne', value: 'PT' }], columns: ['id'], summary: 's', clarification: null };
  await els['#translate'].onclick();
  await els['#run'].onclick();
  assert(els['#status'].textContent.startsWith(`${expectedNotPT} matching rows (scanned 600`), els['#status'].textContent);
  console.log('NOT-PT FILTER OK:', els['#status'].textContent);

  // 3) a malformed local filter from the model is rejected before anything runs
  calls.length = 0; els['#planBox'].hidden = true;
  planToReturn = { request: '/api/v1/users', local_filter: [{ path: 'profile.x', op: 'eval', value: 'alert(1)' }], columns: [], summary: 's', clarification: null };
  await els['#translate'].onclick();
  assert(/rejected/.test(els['#status'].textContent), els['#status'].textContent);
  assert.strictEqual(els['#planBox'].hidden, true);
  assert.strictEqual(calls.length, 0);

  // 4) a plan without local_filter clears a previous one (no stale filter leaks into the next run)
  planToReturn = { request: '/api/v1/users', columns: ['id'], summary: 's', clarification: null };
  await els['#translate'].onclick();
  assert.strictEqual(els['#local'].hidden, true);
  await els['#run'].onclick();
  assert(/^600 rows found in 3 pages/.test(els['#status'].textContent), els['#status'].textContent);
  console.log('NO STALE FILTER OK:', els['#status'].textContent);
})().catch(e => { console.error(e); process.exit(1); });
