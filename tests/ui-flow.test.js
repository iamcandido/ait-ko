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
const pages = {
  '/api/v1/users?search=status+eq+%22ACTIVE%22&limit=200': { body: [{ id: '1', status: 'ACTIVE', profile: { login: 'a' } }, { id: '2', status: 'ACTIVE', profile: { login: 'b' } }], link: '<https://acme.okta.com/api/v1/users?after=2&limit=200>; rel="next"' },
  '/api/v1/users?after=2&limit=200': { body: [{ id: '3', status: 'ACTIVE', profile: { login: 'c' } }], link: '<https://acme.okta.com/api/v1/users?after=3&limit=200>; rel="next"' },
  '/api/v1/users?after=3&limit=200': { body: [], link: '<https://acme.okta.com/api/v1/users?after=3&limit=200>; rel="next"' }
};
const ctx = {
  window: null, console, URL, URLSearchParams, AbortController, Blob, setTimeout, Date, Number, JSON, Object, Array, Math, Promise, Error,
  location: { hostname: 'acme-admin.okta.com', origin: 'https://acme-admin.okta.com' },
  document: { getElementById: () => null, documentElement: { appendChild() {} }, createElement: () => hostEl },
  chrome: { runtime: { id: 'abc', sendMessage: async () => ({ ok: true, plan: planToReturn }) } },
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
  // 1) a valid plan is accepted, shown, and executed with pagination
  planToReturn = { request: '/api/v1/users?search=status eq "ACTIVE"', columns: ['id', 'profile.login', 'status'], summary: 'Active users.', clarification: null };
  els['#prompt'].value = 'active users';
  await els['#translate'].onclick();
  assert(els['#expr'].value.startsWith('/api/v1/users?search=status eq "ACTIVE"'), els['#expr'].value);
  assert.strictEqual(els['#planBox'].hidden, false);
  await els['#run'].onclick();
  assert.strictEqual(calls.length, 3, 'three pages fetched');
  assert(calls.every(c => c.method === 'GET' && c.credentials === 'include'));
  assert(/3 rows found/.test(els['#status'].textContent), els['#status'].textContent);
  assert.strictEqual(els['#csv'].disabled, false);

  // 2) a write/lifecycle request from the model is rejected and never fetched
  const before = calls.length;
  els['#planBox'].hidden = true;
  planToReturn = { request: '/api/v1/users/00u1/lifecycle/deactivate', columns: [], summary: 'x', clarification: null };
  await els['#translate'].onclick();
  assert(/rejected/.test(els['#status'].textContent), els['#status'].textContent);
  assert.strictEqual(els['#planBox'].hidden, true);
  assert.strictEqual(calls.length, before);

  // 3) the user editing the box into something forbidden is also blocked at Run
  els['#expr'].value = '/api/v1/sessions/me';
  await els['#run'].onclick();
  assert(/allowlist/.test(els['#status'].textContent), els['#status'].textContent);
  assert.strictEqual(calls.length, before);

  // 4) model says it is read-only / needs clarification
  planToReturn = { request: null, clarification: 'This tool is read-only.' };
  await els['#translate'].onclick();
  assert(/read-only/.test(els['#status'].textContent));
  console.log('UI FLOW TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
