const ks = AITKO_KEYSTORE.create({ local: chrome.storage.local, session: chrome.storage.session });
const $ = id => document.getElementById(id);
const selectedMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value;

function say(text, isErr = false) {
  $('msg').textContent = text;
  $('msg').className = isErr ? 'err' : 'ok';
}

function toggleFields() {
  const m = selectedMode();
  $('encFields').hidden = m !== 'encrypted';
  $('plainFields').hidden = m !== 'plain';
}

async function load() {
  const { provider, model } = await chrome.storage.local.get(['provider', 'model']);
  $('provider').value = provider || 'gemini';
  $('model').value = model || '';
  const st = await ks.getState();
  const radio = document.querySelector(`input[name="mode"][value="${st.mode}"]`);
  if (radio) radio.checked = true;
  $('legacy').hidden = !st.legacy;
  $('key').placeholder = st.hasKey ? '(a key is set; leave empty to keep it)'
    : st.locked ? '(locked; unlock it from the toolbar icon, or paste the key again)'
    : 'Paste your key here';
  toggleFields();
}

document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', toggleFields));

$('save').onclick = async () => {
  try {
    await chrome.storage.local.set({ provider: $('provider').value, model: $('model').value.trim() });
    const res = await ks.applyMode({
      mode: selectedMode(),
      key: $('key').value.trim(),
      passphrase: $('pass1').value,
      passphrase2: $('pass2').value,
      confirmPlain: $('plainOk').checked
    });
    ['key', 'pass1', 'pass2'].forEach(id => { $(id).value = ''; });
    $('plainOk').checked = false;
    say(res.changed ? 'Saved.' : 'Saved. The key was not changed.');
  } catch (e) {
    say(String(e.message || e), true);
  }
  await load();
};

$('forget').onclick = async () => {
  if (!confirm('Forget the API key everywhere (memory and disk)?')) return;
  await ks.forget();
  say('The key was removed.');
  await load();
};

load();
