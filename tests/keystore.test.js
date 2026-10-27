const assert = require('assert');
const KS = require('../extension/keystore.js');

const mkStore = () => {
  const d = {};
  return {
    d,
    async get(k) { const keys = k == null ? Object.keys(d) : [].concat(k); const o = {}; for (const x of keys) if (x in d) o[x] = structuredClone(d[x]); return o; },
    async set(o) { Object.assign(d, structuredClone(o)); },
    async remove(k) { for (const x of [].concat(k)) delete d[x]; }
  };
};
const rejects = async (p, re, label) => { try { await p; } catch (e) { assert(re.test(e.message), `${label}: got "${e.message}"`); return; } assert.fail(`${label}: should have thrown`); };

(async () => {
  const SECRET = 'AIzaSyEXAMPLE-secret-key-123456';

  // ---- crypto primitives
  const rec = await KS.encryptKey(SECRET, 'correct horse battery');
  assert.strictEqual(await KS.decryptKey(rec, 'correct horse battery'), SECRET);
  assert(!JSON.stringify(rec).includes(SECRET), 'ciphertext must not contain the key');
  const rec2 = await KS.encryptKey(SECRET, 'correct horse battery');
  assert.notStrictEqual(rec.ct, rec2.ct, 'fresh salt/iv each time');
  assert.notStrictEqual(rec.salt, rec2.salt);
  await rejects(KS.decryptKey(rec, 'wrong passphrase!'), /Wrong passphrase/, 'wrong passphrase');
  await rejects(KS.decryptKey({ ...rec, ct: rec.ct.slice(0, -4) + 'AAAA' }, 'correct horse battery'), /Wrong passphrase/, 'tampered ciphertext');
  await rejects(KS.decryptKey({ ...rec, iter: 1 }, 'x'), /corrupted/, 'iteration floor');
  await rejects(KS.decryptKey({ ...rec, iter: 1e9 }, 'x'), /corrupted/, 'iteration ceiling');
  await rejects(KS.decryptKey(null, 'x'), /corrupted/, 'null record');
  assert(rec.iter >= 600000);

  // ---- fresh install: default is session
  let local = mkStore(), session = mkStore();
  let ks = KS.create({ local, session });
  let st = await ks.getState();
  assert.deepStrictEqual([st.mode, st.hasKey, st.stored, st.locked, st.legacy], ['session', false, false, false, false]);
  await rejects(ks.applyMode({ mode: 'session' , key: '' }), /./, 'session needs a key') .catch(() => {});
  assert.deepStrictEqual(await ks.applyMode({ mode: 'session' }), { changed: false, mode: 'session' }, 'nothing to do');
  await ks.applyMode({ mode: 'session', key: SECRET });
  assert.strictEqual(session.d.apiKey, SECRET);
  assert(!('apiKey' in local.d) && !('encKey' in local.d), 'session mode writes nothing sensitive to disk');
  assert(!JSON.stringify(local.d).includes(SECRET));
  assert.strictEqual(await ks.getKey(), SECRET);
  st = await ks.getState(); assert(st.hasKey && st.mode === 'session');

  // ---- session -> encrypted (validation first)
  await rejects(ks.applyMode({ mode: 'encrypted', passphrase: 'short', passphrase2: 'short' }), /at least 8/, 'short passphrase');
  await rejects(ks.applyMode({ mode: 'encrypted', passphrase: 'long enough 1', passphrase2: 'long enough 2' }), /do not match/, 'mismatch');
  assert(!('encKey' in local.d), 'nothing written when validation fails');
  await ks.applyMode({ mode: 'encrypted', passphrase: 'long enough 1', passphrase2: 'long enough 1' });
  assert(local.d.encKey && local.d.keyMode === 'encrypted');
  assert(!JSON.stringify(local.d).includes(SECRET), 'key is not readable on disk');
  assert.strictEqual(session.d.apiKey, SECRET, 'unlocked right after saving');

  // ---- lock / unlock
  await ks.lock();
  st = await ks.getState(); assert(st.locked && !st.hasKey && st.stored && st.mode === 'encrypted');
  assert.strictEqual(await ks.getKey(), '');
  await rejects(ks.unlock('not the passphrase'), /Wrong passphrase/, 'unlock wrong');
  assert(!('apiKey' in session.d), 'wrong passphrase unlocks nothing');
  await rejects(ks.applyMode({ mode: 'plain', confirmPlain: true }), /locked/, 'cannot convert a locked key');
  await ks.unlock('long enough 1');
  assert.strictEqual(session.d.apiKey, SECRET);

  // ---- change passphrase while unlocked
  await ks.applyMode({ mode: 'encrypted', passphrase: 'a brand new phrase', passphrase2: 'a brand new phrase' });
  await ks.lock();
  await rejects(ks.unlock('long enough 1'), /Wrong passphrase/, 'old passphrase no longer works');
  await ks.unlock('a brand new phrase');
  assert.strictEqual(await ks.getKey(), SECRET);

  // ---- encrypted -> plain needs explicit confirmation, removes the encrypted copy
  await rejects(ks.applyMode({ mode: 'plain' }), /Confirm/, 'plain needs confirmation');
  assert(local.d.encKey, 'still encrypted after refused switch');
  await ks.applyMode({ mode: 'plain', confirmPlain: true });
  assert.strictEqual(local.d.apiKey, SECRET); assert(!('encKey' in local.d)); assert(!('apiKey' in session.d));
  assert.strictEqual(await ks.getKey(), SECRET);

  // ---- plain -> session removes the copy on disk
  await ks.applyMode({ mode: 'session' });
  assert(!('apiKey' in local.d) && !('encKey' in local.d)); assert.strictEqual(session.d.apiKey, SECRET);
  assert.strictEqual(local.d.keyMode, 'session');

  // ---- forget wipes everything
  await ks.forget();
  assert(!('apiKey' in session.d) && !('apiKey' in local.d) && !('encKey' in local.d));
  st = await ks.getState(); assert(st.mode === 'session' && !st.hasKey);

  // ---- migration: key saved by an earlier version (local, no keyMode)
  local = mkStore(); session = mkStore(); ks = KS.create({ local, session });
  local.d.apiKey = 'OLD-KEY';
  st = await ks.getState();
  assert.deepStrictEqual([st.mode, st.hasKey, st.legacy], ['plain', true, true]);
  assert.strictEqual(await ks.getKey(), 'OLD-KEY');
  assert.deepStrictEqual(await ks.applyMode({ mode: 'plain' }), { changed: false, mode: 'plain' }, 'no silent changes');
  assert.strictEqual(local.d.apiKey, 'OLD-KEY');
  await ks.applyMode({ mode: 'session' });                 // user opts in to the safer mode; key carried over
  assert.strictEqual(session.d.apiKey, 'OLD-KEY'); assert(!('apiKey' in local.d));
  assert.strictEqual((await ks.getState()).legacy, false);

  // ---- session mode "forget" via lock()
  await ks.lock();
  assert.strictEqual((await ks.getState()).hasKey, false);

  console.log('KEYSTORE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
