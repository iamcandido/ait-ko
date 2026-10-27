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

let planToReturn, respond, opened = false;
const calls = [];
const pages = {
  '/api/v1/users?search=status+eq+%22ACTIVE%22&limit=200': { body: [{ id: '1', status: 'ACTIVE', profile: { login: 'a' } }, { id: '2', status: 'ACTIVE', profile: { login: 'b' } }], link: '<https://acme.okta.com/api/v1/users?after=2&limit=200>; rel="next"' },
  '/api/v1/users?after=2&limit=200': { body: [{ id: '3', status: 'ACTIVE', profile: { login: 'c' } }], link: '<https://acme.okta.com/api/v1/users?after=3&limit=200>; rel="next"' },
  '/api/v1/users?after=3&limit=200': { body: [], link: '<https://acme.okta.com/api/v1/users?after=3&limit=200>; rel="next"' }
};
const ctx = {
  window: null, console, URL, URLSearchParams, AbortController, Blob, setTimeout, Date, Number, JSON, Object, Array, Math, Promise, Error,
  location: { hostname: 'acme-admin.okta.com', origin: 'https://acme-admin.okta.com' },
  document: { getElementById: () => null, documentElement: { appendChild() {} }, createElement: () => hostEl },
  chrome: { runtime: { id: 'abc', sendMessage: async m => (m.type === 'openOptions' ? (opened = true, undefined) : respond) } },
  fetch: async (url, opts) => {
    calls.push({ url, method: opts.method, credentials: opts.credentials });
    const p = pages[url]; assert(p, 'unexpected fetch ' + url);
    return { status: 200, ok: true, headers: { get: h => (h.toLowerCase() === 'link' ? p.link : null) }, json: async () => p.body };
  }
};
ctx.window = ctx; ctx.window.top = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'lib.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8'), ctx);

(async () => {
  els['#prompt'].value = 'x';
  respond = { ok: false, error: 'The API key is locked. Click the AiT.KO toolbar icon to unlock it.', code: 'LOCKED' };
  await els['#translate'].onclick();
  assert.strictEqual(els['#settings'].hidden, false, 'settings shortcut shown for key problems');
  assert(/locked/.test(els['#status'].textContent));
  await els['#settings'].onclick(); assert.strictEqual(opened, true);
  respond = { ok: false, error: 'Gemini API: HTTP 500' };
  await els['#translate'].onclick();
  assert.strictEqual(els['#settings'].hidden, true, 'no shortcut for other errors');
  respond = { ok: true, plan: { request: '/api/v1/users', columns: [], summary: 's' } };
  await els['#translate'].onclick();
  assert.strictEqual(els['#settings'].hidden, true);
  console.log('SETTINGS SHORTCUT OK');
})().catch(e => { console.error(e); process.exit(1); });
