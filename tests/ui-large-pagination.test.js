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
const TOTAL_PAGES = 60;
const page = n => Array.from({ length: 200 }, (_, i) => ({ id: `u${n}-${i}`, status: 'ACTIVE', profile: { login: `x${n}-${i}` } }));
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
  planToReturn = { request: '/api/v1/users', columns: ['id'], summary: 'All users.', clarification: null };
  els['#prompt'].value = 'all users';
  await els['#translate'].onclick();
  assert.strictEqual(els['#expr'].value, '/api/v1/users', 'default limit hidden: ' + els['#expr'].value);
  await els['#run'].onclick();
  assert.strictEqual(calls.length, TOTAL_PAGES, 'pages fetched: ' + calls.length);
  assert(/12000 rows found in 60 pages\./.test(els['#status'].textContent) || /12000 rows found in 60 pages/.test(els['#status'].textContent), els['#status'].textContent);
  console.log('LARGE PAGINATION OK:', els['#status'].textContent);
})().catch(e => { console.error(e); process.exit(1); });
