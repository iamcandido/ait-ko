const vm = require('vm'), fs = require('fs'), assert = require('assert');
const mkStore = () => { const d = {}; return { d,
  async get(k) { const keys = k == null ? Object.keys(d) : [].concat(k); const o = {}; for (const x of keys) if (x in d) o[x] = d[x]; return o; },
  async set(o) { Object.assign(d, o); }, async remove(k) { for (const x of [].concat(k)) delete d[x]; } }; };

const GOOD_PLAN = JSON.stringify({ request: '/api/v1/users', columns: [], summary: 's', clarification: null });
const modelsDefault = () => [
  'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash-preview',
  'gemini-3.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-flash-latest'
].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] }))
 .concat([{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }]);

function load() {
  const local = mkStore(), session = mkStore();
  const calls = []; let listener; let opened = false; let accessLevel = null;
  const st = { models: modelsDefault(), dead: new Set(), genError: null, listFail: null, claude404: false, listCalls: 0 };
  session.setAccessLevel = async o => { accessLevel = o.accessLevel; };
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const err = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
  const ctx = {
    chrome: { runtime: { onMessage: { addListener: f => { listener = f; } }, openOptionsPage: () => { opened = true; } }, storage: { local, session } },
    fetch: async (url, opts = {}) => {
      calls.push({ url, headers: opts.headers || {}, body: opts.body });
      if (url.includes('generativelanguage') && url.includes('/models?')) {
        st.listCalls++;
        return st.listFail ? err(st.listFail.status, st.listFail.msg) : ok({ models: st.models });
      }
      if (url.includes('api.anthropic.com/v1/models')) return ok({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] });
      if (url.includes(':generateContent')) {
        const model = url.match(/models\/([^:]+):/)[1];
        if (st.dead.has(model)) return err(404, `This model models/${model} is no longer available.`);
        if (st.genError) return err(st.genError.status, st.genError.msg);
        return ok({ candidates: [{ content: { parts: [{ text: GOOD_PLAN }] } }] });
      }
      if (url.includes('api.anthropic.com/v1/messages')) return st.claude404 ? err(404, 'model: nope') : ok({ content: [{ text: GOOD_PLAN }] });
      throw new Error('unexpected fetch ' + url);
    },
    URL, JSON, String, Error, Date, encodeURIComponent, console, Promise, Set, Number, Array, Object, RegExp
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../extension/background.js', 'utf8'), ctx);
  const send = msg => new Promise(res => { const r = listener(msg, {}, res); if (r !== true) res(undefined); });
  const gen = () => calls.filter(c => c.url.includes(':generateContent'));
  return { local, session, calls, st, send, gen, opened: () => opened, accessLevel: () => accessLevel };
}
const tr = t => t.send({ type: 'translate', prompt: 'x' });

(async () => {
  let t = load();
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(t.accessLevel(), 'TRUSTED_CONTEXTS', 'session storage restricted to trusted contexts');

  // ---- keys
  let r = await tr(t);
  assert(!r.ok && r.code === 'NO_KEY' && /toolbar icon/.test(r.error), JSON.stringify(r));
  assert.strictEqual(t.calls.length, 0, 'no request to a provider without a key');

  // ---- Gemini, automatic model: picks the newest stable Flash, ignores previews/images/tts/embeddings
  t.session.d.apiKey = 'SESSION-KEY';
  r = await tr(t);
  assert(r.ok && r.plan.request === '/api/v1/users', JSON.stringify(r));
  assert.strictEqual(t.st.listCalls, 1);
  assert(t.gen()[0].url.includes('/models/gemini-3.5-flash:generateContent'), t.gen()[0].url);
  assert.strictEqual(t.gen()[0].headers['x-goog-api-key'], 'SESSION-KEY');
  assert.strictEqual(t.local.d.geminiAutoModel.name, 'gemini-3.5-flash');
  // cached: no new listing
  await tr(t); assert.strictEqual(t.st.listCalls, 1, 'cached model reused');
  // cache expires after a week
  t.local.d.geminiAutoModel.at = Date.now() - 8 * 24 * 3600 * 1000;
  await tr(t); assert.strictEqual(t.st.listCalls, 2, 'stale cache refreshed');

  // ---- the automatically chosen model gets retired: pick again, once, and succeed
  t.st.dead.add('gemini-3.5-flash'); t.st.models = modelsDefault().filter(m => m.name !== 'models/gemini-3.5-flash');
  const before = t.gen().length;
  r = await tr(t);
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(t.gen().length - before, 2, 'one failed call, one retry');
  assert.strictEqual(t.local.d.geminiAutoModel.name, 'gemini-2.5-flash');

  // ---- a model chosen by the user is never replaced behind their back
  t = load(); t.session.d.apiKey = 'K'; t.local.d.model = 'gemini-old'; t.st.dead.add('gemini-old');
  r = await tr(t);
  assert(!r.ok && r.code === 'MODEL', JSON.stringify(r));
  assert(/no longer available/.test(r.error) && /List available models/.test(r.error), r.error);
  assert.strictEqual(t.st.listCalls, 0, 'no automatic switch of a user-chosen model');
  assert.strictEqual(t.gen().length, 1);

  // ---- provider messages are surfaced, and key problems point to the settings
  t = load(); t.session.d.apiKey = 'K'; t.local.d.model = 'm';
  t.st.genError = { status: 429, msg: 'Quota exceeded for this model.' };
  r = await tr(t);
  assert(!r.ok && r.error === 'Gemini API: HTTP 429: Quota exceeded for this model.' && !r.code, JSON.stringify(r));
  t.st.genError = { status: 400, msg: 'API key not valid. Please pass a valid API key.' };
  r = await tr(t); assert(!r.ok && r.code === 'KEY' && /API key not valid/.test(r.error), JSON.stringify(r));
  t.st.genError = { status: 403, msg: 'Permission denied.' };
  r = await tr(t); assert(r.code === 'KEY');
  t = load(); t.session.d.apiKey = 'BAD'; t.st.listFail = { status: 400, msg: 'API key not valid. Please pass a valid API key.' };
  r = await tr(t); assert(!r.ok && r.code === 'KEY', 'invalid key found while listing models: ' + JSON.stringify(r));
  t.st.genError = { status: 500, msg: 'x'.repeat(1000) }; t.st.listFail = null; t.local.d.model = 'm';
  r = await tr(t); assert(r.error.length < 400, 'long provider messages are truncated');

  // ---- model selection rules
  t = load(); t.session.d.apiKey = 'K';
  t.st.models = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] }));
  await tr(t); assert.strictEqual(t.local.d.geminiAutoModel.name, 'gemini-3.5-flash-lite', 'falls back to the newest Flash-Lite');
  delete t.local.d.geminiAutoModel; t.st.models = [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }];
  await tr(t); assert.strictEqual(t.local.d.geminiAutoModel.name, 'gemini-flash-latest', 'then the -latest alias');
  delete t.local.d.geminiAutoModel; t.st.models = [{ name: 'models/gemini-3.9-pro', supportedGenerationMethods: ['generateContent'] }];
  r = await tr(t); assert(!r.ok && r.code === 'MODEL' && /No suitable/.test(r.error), JSON.stringify(r));
  delete t.local.d.geminiAutoModel; t.st.models = ['gemini-3.10-flash', 'gemini-3.9-flash'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] }));
  await tr(t); assert.strictEqual(t.local.d.geminiAutoModel.name, 'gemini-3.10-flash', 'versions compare numerically');

  // ---- Claude
  t = load(); t.session.d.apiKey = 'CK'; t.local.d.provider = 'anthropic';
  r = await tr(t);
  assert(r.ok); const c = t.calls.find(x => x.url.includes('/v1/messages'));
  assert.strictEqual(c.headers['x-api-key'], 'CK'); assert.strictEqual(JSON.parse(c.body).model, 'claude-sonnet-5-5');
  assert.strictEqual(t.st.listCalls, 0, 'no model listing for Claude');
  t.local.d.model = 'claude-custom'; await tr(t);
  assert.strictEqual(JSON.parse(t.calls.filter(x => x.url.includes('/v1/messages')).pop().body).model, 'claude-custom');
  t.st.claude404 = true; r = await tr(t);
  assert(!r.ok && r.code === 'MODEL' && /List available models/.test(r.error), JSON.stringify(r));

  // ---- listModels (options page)
  t = load();
  r = await t.send({ type: 'listModels', provider: 'gemini' });
  assert(!r.ok && r.code === 'NO_KEY', 'needs a key');
  r = await t.send({ type: 'listModels', provider: 'gemini', apiKey: '  TYPED  ' });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'TYPED', 'a typed, unsaved key can be tested');
  assert.deepStrictEqual([...r.models], ['gemini-flash-latest', 'gemini-3.6-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    'only text models, newest first: ' + JSON.stringify(r.models));
  t.session.d.apiKey = 'SAVED';
  r = await t.send({ type: 'listModels', provider: 'anthropic' });
  assert(r.ok && r.models.join() === 'claude-b,claude-a', JSON.stringify(r));
  assert.strictEqual(t.calls.pop().headers['x-api-key'], 'SAVED');

  // ---- locked / legacy / plain keys
  t = load(); t.local.d.keyMode = 'encrypted'; t.local.d.encKey = { v: 1 };
  r = await tr(t); assert(!r.ok && r.code === 'LOCKED' && /locked/.test(r.error)); assert.strictEqual(t.calls.length, 0);
  t.session.d.apiKey = 'UNLOCKED'; r = await tr(t); assert(r.ok); assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'UNLOCKED');
  t = load(); t.local.d.keyMode = 'encrypted'; r = await tr(t); assert(!r.ok && r.code === 'NO_KEY');
  t = load(); t.local.d.apiKey = 'LEGACY'; r = await tr(t); assert(r.ok); assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'LEGACY');
  t = load(); t.local.d.keyMode = 'plain'; t.local.d.apiKey = 'DISK'; t.session.d.apiKey = 'STALE';
  await tr(t); assert.strictEqual(t.calls[0].headers['x-goog-api-key'], 'DISK');

  // ---- misc
  await t.send({ type: 'openOptions' }); assert.strictEqual(t.opened(), true);
  assert.strictEqual(await t.send({ type: 'something-else' }), undefined);

  console.log('BACKGROUND TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
