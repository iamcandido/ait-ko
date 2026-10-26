// API key storage for AiT.KO. Three modes, chosen by the user:
//   session   (default) key kept only in chrome.storage.session: memory, wiped when the browser closes
//   encrypted key saved on disk encrypted with a passphrase (PBKDF2-SHA256 -> AES-GCM); unlocking
//             copies the decrypted key into chrome.storage.session for the rest of the browser session
//   plain     key saved on disk unencrypted in chrome.storage.local (explicit opt-in)
// Only extension pages (popup, options) and the service worker can read chrome.storage.session by default;
// content scripts, which run inside the Okta page, never touch the key.
(() => {
  'use strict';

  const webcrypto = globalThis.crypto || (typeof require !== 'undefined' ? require('node:crypto').webcrypto : undefined);
  const ITER = 600000;                                   // PBKDF2-HMAC-SHA256 iterations
  const MODES = ['session', 'encrypted', 'plain'];
  const AAD = new TextEncoder().encode('ait-ko:key:v1'); // binds the ciphertext to this purpose/version

  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function deriveKey(passphrase, salt, iterations) {
    const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encryptKey(apiKey, passphrase) {
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const k = await deriveKey(passphrase, salt, ITER);
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, k, new TextEncoder().encode(apiKey));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  async function decryptKey(rec, passphrase) {
    // Bounds on "iter" stop a tampered record from freezing the browser.
    if (!rec || rec.v !== 1 || rec.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(rec.iter) || rec.iter < 100000 || rec.iter > 5000000) {
      throw new Error('The stored key is corrupted. Forget it and enter the API key again.');
    }
    try {
      const k = await deriveKey(passphrase, unb64(rec.salt), rec.iter);
      const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: AAD }, k, unb64(rec.ct));
      return new TextDecoder().decode(pt);
    } catch {
      throw new Error('Wrong passphrase.');
    }
  }

  // local / session: objects with promise-based get(keys), set(obj), remove(keys), like chrome.storage areas.
  function create({ local, session }) {
    async function getState() {
      const L = await local.get(['keyMode', 'apiKey', 'encKey']);
      const S = await session.get('apiKey');
      const mode = L.keyMode || (L.apiKey ? 'plain' : 'session'); // keys from earlier versions live in local, unencrypted
      const stored = mode === 'encrypted' ? !!L.encKey : mode === 'plain' ? !!L.apiKey : false;
      const hasKey = mode === 'plain' ? !!L.apiKey : !!S.apiKey;
      return { mode, stored, hasKey, locked: mode === 'encrypted' && !!L.encKey && !S.apiKey, legacy: !L.keyMode && !!L.apiKey };
    }

    async function getKey() {
      const st = await getState();
      if (st.mode === 'plain') return (await local.get('apiKey')).apiKey || '';
      return (await session.get('apiKey')).apiKey || '';
    }

    // Switch mode and/or set a new key. The previous copy is always removed.
    async function applyMode({ mode, key = '', passphrase = '', passphrase2 = '', confirmPlain = false }) {
      if (!MODES.includes(mode)) throw new Error('Choose how to store the key.');
      const st = await getState();
      const modeChanged = mode !== st.mode;
      const newPass = mode === 'encrypted' && !!passphrase;
      if (!modeChanged && !key && !newPass) return { changed: false, mode };

      const newKey = key || (await getKey());
      if (!newKey) throw new Error(st.locked ? 'The stored key is locked. Unlock it first, or paste the API key again.' : 'Enter the API key.');

      if (mode === 'encrypted') {
        if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
        if (passphrase !== passphrase2) throw new Error('The passphrases do not match.');
        const rec = await encryptKey(newKey, passphrase);
        await local.set({ keyMode: 'encrypted', encKey: rec });
        await local.remove('apiKey');
        await session.set({ apiKey: newKey });
      } else if (mode === 'plain') {
        if (!confirmPlain) throw new Error('Confirm that you understand the key will be stored without encryption.');
        await local.set({ keyMode: 'plain', apiKey: newKey });
        await local.remove('encKey');
        await session.remove('apiKey');
      } else {
        await session.set({ apiKey: newKey });
        await local.set({ keyMode: 'session' });
        await local.remove(['apiKey', 'encKey']);
      }
      return { changed: true, mode };
    }

    async function unlock(passphrase) {
      const L = await local.get(['keyMode', 'encKey']);
      if (L.keyMode !== 'encrypted' || !L.encKey) throw new Error('No encrypted key is saved.');
      const key = await decryptKey(L.encKey, passphrase);
      await session.set({ apiKey: key });
    }

    const lock = () => session.remove('apiKey');   // also "forget" for session mode

    async function forget() {
      await session.remove('apiKey');
      await local.remove(['apiKey', 'encKey']);
      await local.set({ keyMode: 'session' });
    }

    return { getState, getKey, applyMode, unlock, lock, forget };
  }

  const api = { create, encryptKey, decryptKey, ITER };
  globalThis.AITKO_KEYSTORE = api;
  if (typeof module !== 'undefined') module.exports = api;
})();