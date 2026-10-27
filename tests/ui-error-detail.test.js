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
    return { status: 400, ok: false, headers: { get: () => null }, json: async () => ({ errorCode: 'E0000031', errorSummary: 'Invalid search criteria.' }) };
  }
};
ctx.window = ctx; ctx.window.top = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'lib.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8'), ctx);

(async () => {
  planToReturn = { request: '/api/v1/users?search=status eq "ACTIVE" and profile.countryCode ne "PT"', columns: ['id'], summary: 's', clarification: null };
  els['#prompt'].value = 'active users not in Portugal';
  await els['#translate'].onclick();
  assert(els['#expr'].value.includes('lt "PT" or profile.countryCode gt "PT"'), els['#expr'].value);
  await els['#run'].onclick();
  assert.strictEqual(els['#status'].textContent, 'Okta returned HTTP 400: Invalid search criteria.', els['#status'].textContent);
  assert(/%28|\(/.test(calls[0].url) && !/\+ne\+/.test(calls[0].url), calls[0].url);
  console.log('ERROR DETAIL OK:', els['#status'].textContent);
})().catch(e => { console.error(e); process.exit(1); });
