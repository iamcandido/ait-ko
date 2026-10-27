// Drives popup.js and options.js with a fake DOM (no browser available here).
const vm = require('vm'), fs = require('fs'), assert = require('assert');
const { webcrypto } = require('node:crypto');
const ext = f => fs.readFileSync(__dirname + '/../extension/' + f, 'utf8');
const tick = () => new Promise(r => setTimeout(r, 5));

const mkStore = () => { const d = {}; return { d,
  async get(k) { const keys = k == null ? Object.keys(d) : [].concat(k); const o = {}; for (const x of keys) if (x in d) o[x] = structuredClone(d[x]); return o; },
  async set(o) { Object.assign(d, structuredClone(o)); }, async remove(k) { for (const x of [].concat(k)) delete d[x]; } }; };

function page(scriptFile, ids) {
  const local = mkStore(), session = mkStore();
  const el = {}; ids.forEach(id => { el[id] = { id, hidden: false, textContent: '', value: '', checked: false, className: '', placeholder: '', onclick: null, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }; });
  const radios = ['session', 'encrypted', 'plain'].map(v => ({ value: v, checked: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }));
  let opened = false, confirmAnswer = true;
  const ctx = {
    chrome: { storage: { local, session }, runtime: { openOptionsPage: () => { opened = true; } } },
    document: {
      getElementById: id => { assert(el[id], 'element #' + id + ' missing from the page'); return el[id]; },
      querySelector: sel => {
        if (sel === 'input[name="mode"]:checked') return radios.find(r => r.checked) || null;
        const m = sel.match(/value="(\w+)"/); return m ? radios.find(r => r.value === m[1]) : null;
      },
      querySelectorAll: () => radios
    },
    confirm: () => confirmAnswer,
    crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, Uint8Array, Number, String, Error, JSON, Object, Array, Promise, console, setTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(ext('keystore.js'), ctx);
  vm.runInContext(ext(scriptFile), ctx);
  return { el, radios, local, session, opened: () => opened, setConfirm: v => { confirmAnswer = v; } };
}

// every id used by a script must exist in its html, and vice versa for the ones scripts touch
function idsOf(html) { return [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); }
function idsUsed(js) { return [...new Set([...js.matchAll(/\$\('(\w+)'\)/g)].map(m => m[1]))]; }
for (const [html, js] of [['popup.html', 'popup.js'], ['options.html', 'options.js']]) {
  const have = new Set(idsOf(ext(html)));
  for (const id of idsUsed(ext(js))) assert(have.has(id), `${js} uses #${id} but ${html} has no such id`);
  assert(ext(html).includes('src="keystore.js"') && ext(html).includes(`src="${js}"`), `${html} loads its scripts`);
  assert(!/<script(?![^>]*\bsrc=)/.test(ext(html)), `${html} has no inline script (blocked by the extension CSP)`);
}

(async () => {
  // ================= popup =================
  const P = ['state', 'enter', 'unlock', 'active', 'key', 'pass', 'useKey', 'unlockBtn', 'lockBtn', 'msg', 'settings'];
  let p = page('popup.js', P); await tick();
  assert.strictEqual(p.el.enter.hidden, false); assert.strictEqual(p.el.active.hidden, true);
  assert(/No API key/.test(p.el.state.textContent));

  p.el.key.value = '  MY-KEY  '; await p.el.useKey.onclick(); await tick();
  assert.strictEqual(p.session.d.apiKey, 'MY-KEY', 'trimmed and kept in session storage');
  assert(!('apiKey' in p.local.d), 'nothing written to disk');
  assert.strictEqual(p.el.key.value, '', 'input cleared');
  assert.strictEqual(p.el.active.hidden, false); assert.strictEqual(p.el.lockBtn.textContent, 'Forget key');

  await p.el.lockBtn.onclick(); await tick();
  assert(!('apiKey' in p.session.d)); assert.strictEqual(p.el.enter.hidden, false);

  p.el.key.value = ''; await p.el.useKey.onclick(); await tick();
  assert.strictEqual(p.el.msg.className, 'err'); assert(/Enter the API key/.test(p.el.msg.textContent));

  // encrypted + locked -> unlock flow
  p = page('popup.js', P); await tick();
  const ks2 = require('../extension/keystore.js').create({ local: p.local, session: p.session });
  await ks2.applyMode({ mode: 'session', key: 'SECRET-1' });
  await ks2.applyMode({ mode: 'encrypted', passphrase: 'correct horse battery', passphrase2: 'correct horse battery' });
  await ks2.lock();
  await p.el.lockBtn.onclick(); await tick();               // re-render
  assert.strictEqual(p.el.unlock.hidden, false, 'unlock form shown when locked');
  p.el.pass.value = 'wrong wrong wrong'; await p.el.unlockBtn.onclick(); await tick();
  assert(/Wrong passphrase/.test(p.el.msg.textContent) && p.el.msg.className === 'err');
  assert(!('apiKey' in p.session.d));
  p.el.pass.value = 'correct horse battery'; await p.el.unlockBtn.onclick(); await tick();
  assert.strictEqual(p.session.d.apiKey, 'SECRET-1'); assert.strictEqual(p.el.lockBtn.textContent, 'Lock now');
  assert.strictEqual(p.el.pass.value, '', 'passphrase cleared after use');

  // key saved by an earlier version: informative text, no key controls, settings link works
  p = page('popup.js', P); p.local.d.apiKey = 'OLD'; await p.el.settings.onclick({ preventDefault() {} }); await tick();
  assert.strictEqual(p.opened(), true);

  // ================= options =================
  const O = ['legacy', 'provider', 'model', 'key', 'encFields', 'pass1', 'pass2', 'plainFields', 'plainOk', 'save', 'forget', 'msg'];
  let o = page('options.js', O); await tick();
  assert.strictEqual(o.radios.find(r => r.checked).value, 'session', 'default mode is session');
  assert.strictEqual(o.el.legacy.hidden, true);

  o.el.provider.value = 'anthropic'; o.el.model.value = ' claude-x '; o.el.key.value = 'K1';
  await o.el.save.onclick(); await tick();
  assert.strictEqual(o.local.d.provider, 'anthropic'); assert.strictEqual(o.local.d.model, 'claude-x');
  assert.strictEqual(o.session.d.apiKey, 'K1'); assert(!('apiKey' in o.local.d));
  assert.strictEqual(o.el.key.value, '', 'key field cleared'); assert(/key is set/.test(o.el.key.placeholder), 'key value is never shown back');

  // choose encrypted: fields appear, validation works, then it saves encrypted
  o.radios.find(r => r.value === 'encrypted').checked = true; o.radios.find(r => r.value === 'session').checked = false;
  o.radios[1].handlers.change(); assert.strictEqual(o.el.encFields.hidden, false); assert.strictEqual(o.el.plainFields.hidden, true);
  o.el.pass1.value = 'short'; o.el.pass2.value = 'short'; await o.el.save.onclick(); await tick();
  assert(/at least 8/.test(o.el.msg.textContent) && o.el.msg.className === 'err');
  assert(!('encKey' in o.local.d));
  o.radios.forEach(r => { r.checked = r.value === 'encrypted'; });   // radios are exclusive in a real browser
  o.el.pass1.value = 'a decent passphrase'; o.el.pass2.value = 'a decent passphrase'; await o.el.save.onclick(); await tick();
  assert(o.local.d.encKey && o.local.d.keyMode === 'encrypted'); assert(!JSON.stringify(o.local.d).includes('K1'));
  assert.strictEqual(o.el.pass1.value, '');

  // choose plain without confirming -> refused; with confirmation -> saved
  o.radios.forEach(r => { r.checked = r.value === 'plain'; }); o.radios[2].handlers.change();
  assert.strictEqual(o.el.plainFields.hidden, false);
  await o.el.save.onclick(); await tick();
  assert(/Confirm/.test(o.el.msg.textContent)); assert(o.local.d.encKey, 'still encrypted after refusal');
  o.radios.forEach(r => { r.checked = r.value === 'plain'; }); o.el.plainOk.checked = true;
  await o.el.save.onclick(); await tick();
  assert.strictEqual(o.local.d.apiKey, 'K1'); assert(!('encKey' in o.local.d));

  // forget respects the confirmation dialog
  o.setConfirm(false); await o.el.forget.onclick(); await tick();
  assert.strictEqual(o.local.d.apiKey, 'K1', 'cancelled: nothing removed');
  o.setConfirm(true); await o.el.forget.onclick(); await tick();
  assert(!('apiKey' in o.local.d) && !('apiKey' in o.session.d)); assert.strictEqual(o.radios.find(r => r.checked).value, 'session');

  // earlier-version key: migration notice is shown, and a plain Save does not silently change the key
  const o2 = page('options.js', O); o2.local.d.apiKey = 'LEGACY';
  await o2.el.save.onclick(); await tick();
  assert.strictEqual(o2.local.d.apiKey, 'LEGACY', 'saving settings does not silently change the key');
  const o3 = page('options.js', O); o3.local.d.apiKey = 'LEGACY'; await tick();
  assert.strictEqual(o3.el.legacy.hidden, false, 'migration notice shown');
  assert.strictEqual(o3.radios.find(r => r.checked).value, 'plain', 'reflects where the key really is');

  console.log('PAGES TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
