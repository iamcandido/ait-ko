const ks = AITKO_KEYSTORE.create({ local: chrome.storage.local, session: chrome.storage.session });
const $ = id => document.getElementById(id);

function say(text, isErr = false) {
  $('msg').textContent = text;
  $('msg').className = isErr ? 'err' : 'ok';
}

async function render() {
  const st = await ks.getState();
  ['enter', 'unlock', 'active'].forEach(id => { $(id).hidden = true; });
  if (st.mode === 'session') {
    if (st.hasKey) {
      $('state').textContent = 'API key active for this browser session.';
      $('lockBtn').textContent = 'Forget key';
      $('active').hidden = false;
    } else {
      $('state').textContent = 'No API key for this browser session.';
      $('enter').hidden = false;
    }
  } else if (st.mode === 'encrypted') {
    if (!st.stored) {
      $('state').textContent = 'No encrypted key is saved. Open Settings to add one.';
    } else if (st.locked) {
      $('state').textContent = 'The saved API key is locked.';
      $('unlock').hidden = false;
    } else {
      $('state').textContent = 'API key unlocked for this browser session.';
      $('lockBtn').textContent = 'Lock now';
      $('active').hidden = false;
    }
  } else {
    $('state').textContent = 'API key saved on this computer without encryption. You can change this in Settings.';
  }
}

async function run(fn, okText) {
  try { await fn(); say(okText); } catch (e) { say(String(e.message || e), true); }
  await render();
}

$('useKey').onclick = () => run(async () => {
  await ks.applyMode({ mode: 'session', key: $('key').value.trim() });
  $('key').value = '';
}, 'Done.');
$('unlockBtn').onclick = () => run(async () => {
  await ks.unlock($('pass').value);
  $('pass').value = '';
}, 'Unlocked.');
$('lockBtn').onclick = () => run(() => ks.lock(), 'Done.');
$('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('useKey').click(); });
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('unlockBtn').click(); });
$('settings').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

render();