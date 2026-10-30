// Multi-step plans end to end, with a fake Okta and a fake DOM.
const vm = require('vm'), fs = require('fs'), assert = require('assert');
const dir = __dirname + '/../extension/';
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
// types a question and asks for the plan (nothing happens when the box is empty)
const go = async t => { t.els['#prompt'].value = 'a question'; await t.els['#translate'].onclick(); };

function setup(route) {
  const els = {}, created = [], calls = [];
  const mk = () => ({
    value: '', hidden: false, textContent: '', disabled: false, className: '', onclick: null, children: [],
    classList: { add() {}, remove() {} }, addEventListener() {}, appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; },
    createTHead() { return { insertRow() { return { appendChild() {} }; } }; },
    createTBody() { return { insertRow() { return { insertCell() { return {}; } }; } }; }
  });
  const root = { set innerHTML(_) {}, querySelector(sel) { return els[sel] || (els[sel] = mk()); } };
  const state = { plan: null };
  const ctx = {
    console, URL, URLSearchParams, AbortController, Blob, setTimeout, Date, Number, JSON, Object, Array, Math, Promise, Error, String, RegExp, Set,
    location: { hostname: 'acme-admin.okta.com', origin: 'https://acme-admin.okta.com' },
    document: {
      getElementById: () => null, documentElement: { appendChild() {} },
      createElement: tag => { const e = { ...mk(), tag, attachShadow() { return root; } }; created.push(e); return e; }
    },
    chrome: { runtime: { id: 'abc', sendMessage: async () => ({ ok: true, plan: state.plan }) } },
    fetch: async (url, opts) => {
      calls.push(url);
      assert.strictEqual(opts.method, 'GET'); assert.strictEqual(opts.credentials, 'include');
      const r = route(url); assert(r, 'unexpected fetch ' + url);
      return { status: r.status || 200, ok: (r.status || 200) < 400, headers: { get: h => (h.toLowerCase() === 'link' ? r.link || null : null) }, json: async () => r.body };
    }
  };
  ctx.window = ctx; ctx.window.top = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(dir + 'lib.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8'), ctx);
  const pickButtons = () => created.filter(e => e.tag === 'button' && /pickItem/.test(e.className));
  return { els, calls, state, pickButtons };
}

const APP_PLAN = () => ({
  request: null, summary: 'Users assigned to the app.',
  steps: [
    { name: 'app', request: '/api/v1/apps?q=Okta Admin Console', pick: true, columns: ['id', 'label', 'status'] },
    { request: '/api/v1/apps/{{app.id}}/users?expand=user', columns: ['_embedded.user.profile.firstName', '_embedded.user.profile.email', '_embedded.user.profile.countryCode'] }
  ]
});
const appUser = (n, cc) => ({ id: 'u' + n, status: 'ACTIVE', _embedded: { user: { profile: { firstName: 'N' + n, email: `n${n}@x.com`, countryCode: cc } } } });

(async () => {
  // ===== A) several apps match: the user chooses; ids are filled in locally; two pages of users
  let t = setup(url => {
    if (url.startsWith('/api/v1/apps?')) return { body: [{ id: 'APP1', label: 'Okta Admin Console (old)', status: 'INACTIVE' }, { id: 'APP2', label: 'Okta Admin Console', status: 'ACTIVE' }] };
    if (url === '/api/v1/apps/APP2/users?expand=user&limit=200') return { body: [appUser(1, 'PT'), appUser(2, 'ES')], link: '<https://acme.okta.com/api/v1/apps/APP2/users?after=u2&expand=user&limit=200>; rel="next"' };
    if (url.startsWith('/api/v1/apps/APP2/users?after=u2')) return { body: [appUser(3, '')] };
  });
  t.state.plan = APP_PLAN();
  await go(t);
  assert.strictEqual(t.els['#planBox'].hidden, false);
  assert.strictEqual(t.els['#expr'].hidden, true, 'multi-step plans are not editable');
  assert.strictEqual(t.els['#steps'].hidden, false);
  assert(/1\. \/api\/v1\/apps\?q=Okta Admin Console {2}→ you choose one result/.test(t.els['#steps'].textContent), t.els['#steps'].textContent);
  assert(/2\. \/api\/v1\/apps\/\{\{app\.id\}\}\/users/.test(t.els['#steps'].textContent));
  assert.strictEqual(t.calls.length, 0, 'nothing runs before the user clicks Run');

  const run = t.els['#run'].onclick();
  await tick();
  assert.strictEqual(t.els['#pickBox'].hidden, false, 'asks which one');
  const btns = t.pickButtons(); assert.strictEqual(btns.length, 2);
  assert(/APP2/.test(btns[1].textContent) && /Okta Admin Console/.test(btns[1].textContent), btns[1].textContent);
  assert.strictEqual(t.calls.length, 1, 'step 2 waits for the choice');
  btns[1].onclick();
  await run;
  assert.deepStrictEqual([...t.calls], [
    '/api/v1/apps?q=Okta+Admin+Console&limit=200',
    '/api/v1/apps/APP2/users?expand=user&limit=200',
    '/api/v1/apps/APP2/users?after=u2&expand=user&limit=200'
  ]);
  assert(/^3 rows found in 2 pages\./.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.els['#csv'].disabled, false);
  assert.strictEqual(t.els['#pickBox'].hidden, true);

  // ===== B) a single match is used without asking
  t = setup(url => {
    if (url.startsWith('/api/v1/apps?')) return { body: [{ id: 'APP9', label: 'Okta Admin Console', status: 'ACTIVE' }] };
    if (url.startsWith('/api/v1/apps/APP9/users')) return { body: [appUser(1, 'PT')] };
  });
  t.state.plan = APP_PLAN();
  await go(t); await t.els['#run'].onclick();
  assert.strictEqual(t.pickButtons().length, 0, 'no question when there is only one match');
  assert(/1 rows found/.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.calls.length, 2);

  // ===== C) nothing found
  t = setup(url => url.startsWith('/api/v1/apps?') ? { body: [] } : null);
  t.state.plan = APP_PLAN(); await go(t); await t.els['#run'].onclick();
  assert(/Nothing found for "app"/.test(t.els['#status'].textContent) && t.els['#status'].className === 'err', t.els['#status'].textContent);
  assert.strictEqual(t.calls.length, 1, 'step 2 never runs');

  // ===== D) a hostile id returned by the server cannot redirect the next request
  for (const evil of ['../../sessions/me', 'a/b', 'x?after=1', '..', '', 'a b']) {
    t = setup(url => url.startsWith('/api/v1/apps?') ? { body: [{ id: evil, label: 'Okta Admin Console' }] } : null);
    t.state.plan = APP_PLAN(); await go(t); await t.els['#run'].onclick();
    assert(/Step 1\/2: Cannot use "id"/.test(t.els['#status'].textContent) || /Step 2\/2/.test(t.els['#status'].textContent), `${JSON.stringify(evil)}: ${t.els['#status'].textContent}`);
    assert.strictEqual(t.calls.length, 1, 'no second request for ' + JSON.stringify(evil));
  }

  // ===== E) for_each: one request per group, each row tagged with its source
  const groups = n => Array.from({ length: n }, (_, i) => ({ id: 'G' + i, profile: { name: 'Finance ' + i } }));
  const FE_PLAN = () => ({ request: null, summary: 's', steps: [
    { name: 'groups', request: '/api/v1/groups?q=Finance' },
    { for_each: 'groups', request: '/api/v1/groups/{{row.id}}/users', columns: ['_source', 'profile.login'] }] });
  t = setup(url => {
    if (url.startsWith('/api/v1/groups?')) return { body: groups(3) };
    const m = url.match(/^\/api\/v1\/groups\/(G\d)\/users/); if (m) return { body: [{ profile: { login: m[1] + '-a' } }, { profile: { login: m[1] + '-b' } }] };
  });
  t.state.plan = FE_PLAN(); await go(t);
  assert(/once for each result of "groups"/.test(t.els['#steps'].textContent));
  await t.els['#run'].onclick();
  assert.strictEqual(t.calls.length, 4);
  assert(/^6 rows found in 3 pages/.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.els['#json'].disabled, false);

  // ...and refuses to fan out over too many rows
  t = setup(url => url.startsWith('/api/v1/groups?') ? { body: groups(51) } : null);
  t.state.plan = FE_PLAN(); await go(t); await t.els['#run'].onclick();
  assert(/returned 51 results/.test(t.els['#status'].textContent) && /maximum 50/.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.calls.length, 1);
  // ...or when the first step returns nothing
  t = setup(url => url.startsWith('/api/v1/groups?') ? { body: [] } : null);
  t.state.plan = FE_PLAN(); await go(t); await t.els['#run'].onclick();
  assert(/nothing to repeat/.test(t.els['#status'].textContent));

  // ===== F) Stop while waiting for the user's choice
  t = setup(url => url.startsWith('/api/v1/apps?') ? { body: [{ id: 'A1', label: 'x' }, { id: 'A2', label: 'y' }] } : null);
  t.state.plan = APP_PLAN(); await go(t);
  const p = t.els['#run'].onclick(); await tick();
  assert.strictEqual(t.els['#pickBox'].hidden, false);
  t.els['#stop'].onclick(); await p;
  assert(/^Stopped/.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.els['#pickBox'].hidden, true); assert.strictEqual(t.els['#run'].disabled, false);
  assert.strictEqual(t.calls.length, 1, 'nothing else ran');

  // ===== G) a dangerous plan is rejected before anything is shown or run
  t = setup(() => null);
  t.state.plan = { request: null, steps: [{ name: 'u', request: '/api/v1/users?q=ana', pick: true }, { request: '/api/v1/users/{{u.id}}/lifecycle/deactivate' }] };
  await go(t);
  assert(/rejected/.test(t.els['#status'].textContent) && /Step 2/.test(t.els['#status'].textContent), t.els['#status'].textContent);
  assert.strictEqual(t.els['#planBox'].hidden, true); assert.strictEqual(t.calls.length, 0);

  // ===== H) switching back to a simple request restores the editable box
  t = setup(url => url.startsWith('/api/v1/users') ? { body: [{ id: '1', status: 'ACTIVE', profile: { login: 'a' } }] } : null);
  t.state.plan = APP_PLAN(); await go(t);
  assert.strictEqual(t.els['#expr'].hidden, true);
  t.state.plan = { request: '/api/v1/users?search=status eq "ACTIVE"', columns: ['id'], summary: 's' };
  await go(t);
  assert.strictEqual(t.els['#expr'].hidden, false); assert.strictEqual(t.els['#steps'].hidden, true);
  assert(/Request \(read-only GET, editable\)/.test(t.els['#exprLabel'].textContent));
  await t.els['#run'].onclick();
  assert(/1 rows found in 1 page\./.test(t.els['#status'].textContent), t.els['#status'].textContent);

  console.log('MULTI-STEP UI TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
