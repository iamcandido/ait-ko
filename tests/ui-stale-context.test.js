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

let planToReturn, respond, opened = false, dead = null;
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
  chrome: { runtime: { id: 'abc', sendMessage: async m => { if (dead === 'throw') throw new Error('Extension context invalidated.'); return (m.type === 'openOptions' ? (opened = true, undefined) : respond); } } },
  fetch: async (url, opts) => {
    calls.push({ url, method: opts.method, credentials: opts.credentials });
    const p = pages[url]; assert(p, 'unexpected fetch ' + url);
    return { status: 200, ok: true, headers: { get: h => (h.toLowerCase() === 'link' ? p.link : null) }, json: async () => p.body };
  }
};
ctx.ctx = ctx; ctx.window = ctx; ctx.window.top = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'lib.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8'), ctx);

(async () => {
  els['#prompt'].value = 'x';
  // 1) sendMessage throws "Extension context invalidated" (extension reloaded while the page was open)
  dead = 'throw';
  await els['#translate'].onclick();
  assert.strictEqual(els['#reload'].hidden, false, 'reload button offered');
  assert.strictEqual(els['#settings'].hidden, true);
  assert(/Reload this page/.test(els['#status'].textContent), els['#status'].textContent);
  // 2) chrome.runtime.id is gone (other form of the same situation)
  dead = null; ctx.chrome.runtime.id = undefined;
  await els['#translate'].onclick();
  assert.strictEqual(els['#reload'].hidden, false);
  assert(/updated or reloaded/.test(els['#status'].textContent));
  // 3) the settings shortcut also copes with a dead connection
  dead = 'throw'; ctx.chrome.runtime.id = 'abc'; els['#reload'].hidden = true;
  await els['#settings'].onclick();
  assert.strictEqual(els['#reload'].hidden, false);
  // 4) healthy again: button hidden, normal flow works
  dead = null; respond = { ok: true, plan: { request: '/api/v1/users', columns: [], summary: 's' } };
  await els['#translate'].onclick();
  assert.strictEqual(els['#reload'].hidden, true); assert.strictEqual(els['#planBox'].hidden, false);
  // 5) other errors are still shown as they are, without the reload button
  respond = { ok: false, error: 'Gemini API: HTTP 500' };
  await els['#translate'].onclick();
  assert.strictEqual(els['#reload'].hidden, true); assert(/HTTP 500/.test(els['#status'].textContent));
  console.log('STALE CONTEXT HANDLING OK');
})().catch(e => { console.error(e); process.exit(1); });
