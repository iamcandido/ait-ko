const $ = id => document.getElementById(id);
chrome.storage.local.get(['provider', 'apiKey', 'model']).then(v => {
  $('provider').value = v.provider || 'gemini';
  $('key').value = v.apiKey || '';
  $('model').value = v.model || '';
});
$('save').onclick = async () => {
  await chrome.storage.local.set({
    provider: $('provider').value,
    apiKey: $('key').value.trim(),
    model: $('model').value.trim()
  });
  $('msg').textContent = 'Saved.';
};