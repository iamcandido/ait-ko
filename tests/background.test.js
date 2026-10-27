const vm = require('vm'), fs = require('fs'), assert = require('assert');
const mkStore = () => { const d = {}; return { d,
  async get(k) { const keys = k == null ? Object.keys(d) : [].concat(k); const o = {}; for (const x of keys) if (x in d) o[x] = d[x]; return o; },
  async set(o) { Object.assign(d, o); }, async remove(k) { for (const x of [].concat(k)) delete d[x]; } }; };

function load() {
  const local = mkStore(), session = mkStore();
  const calls = []; let listener; let opened = false; let accessLevel = null;
  session.setAccessLevel = async o => { accessLevel = o.accessLevel; };
  const ctx = {
    chrome: { runtime: { onMessage: { addListener: f => { listener = f; } }, openOptionsPage: () => { opened = true; } }, storage: { local, session } },
    fetch: async (url, opts) => { calls.push({ url, headers: opts.headers });
      const body = JSON.stringify({ request: '/api/v1/users', columns: [], summary: 's', clarification: null });
      return { ok: true, status: 200,
        json: async () => (url.includes('anthropic') ? { content: [{ text: body }] } : { candidates: [{ content: { parts: [{ text: body }] } }] }) }; },
    URL, JSON, String, Error, Date, encodeURIComponent, console, Promise
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../extension/background.js', 'utf8'), ctx);
  const send = msg => new Promise(res => { const r = listener(msg, {}, res); if (r !== true) res(undefined); });
  return { local, session, calls, send, opened: () => opened, accessLevel: () => accessLevel };
}

(async () => {
  let t = load();
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(t.accessLevel(), 'TRUSTED_CONTEXTS', 'session storage restricted to trusted contexts');

  // nothing set (default session mode)
  let r = await t.send({ type: 'translate', prompt: 'x' });
  assert(!r.ok && r.code === 'NO_KEY' && /toolbar icon/.test(r.error), JSON.stringify(r));
  assert.strictEqual(t.calls.length, 0, 'no request to the provider without a key');

  // session key is used (Gemini header)
  t.session.d.apiKey = 'SESSION-KEY';
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(r.ok && r.plan.request === '/api/v1/users', JSON.stringify(r));
  assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'SESSION-KEY');

  // Claude provider uses its own header
  t.local.d.provider = 'anthropic';
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(r.ok); assert.strictEqual(t.calls[1].headers['x-api-key'], 'SESSION-KEY');

  // encrypted + locked: clear message, no request
  t = load();
  t.local.d.keyMode = 'encrypted'; t.local.d.encKey = { v: 1 };
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(!r.ok && r.code === 'LOCKED' && /locked/.test(r.error), JSON.stringify(r));
  assert.strictEqual(t.calls.length, 0);
  t.session.d.apiKey = 'UNLOCKED';                         // after unlocking in the popup
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(r.ok); assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'UNLOCKED');

  // encrypted mode but nothing saved: not "locked"
  t = load(); t.local.d.keyMode = 'encrypted';
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(!r.ok && r.code === 'NO_KEY');

  // key saved by an earlier version keeps working
  t = load(); t.local.d.apiKey = 'LEGACY';
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert(r.ok); assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'LEGACY');

  // plain mode ignores a stale session key
  t = load(); t.local.d.keyMode = 'plain'; t.local.d.apiKey = 'DISK'; t.session.d.apiKey = 'STALE';
  r = await t.send({ type: 'translate', prompt: 'x' });
  assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'DISK');

  // shortcut to the settings page
  await t.send({ type: 'openOptions' });
  assert.strictEqual(t.opened(), true);
  assert.strictEqual(await t.send({ type: 'something-else' }), undefined);

  console.log('BACKGROUND TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
