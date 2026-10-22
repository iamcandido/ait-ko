// Service worker: translates natural language -> Okta "search" expression.
// Only the text of the request goes to the API (Gemini or Claude); no user data ever leaves the browser.

const SYSTEM = `Convert natural-language requests into a "search" expression for the Okta API GET /api/v1/users.
Reply with JSON ONLY, no extra text and no markdown:
{"search": string|null, "columns": string[], "summary": string, "clarification": string|null}

Rules:
- Syntax: attribute operator "value", combined with and / or / not and parentheses. Operators: eq sw co gt ge lt le pr.
- Allowed attributes: status, id, created, lastUpdated, lastLogin, statusChanged, profile.<attribute>.
- Common profile attributes: login, email, firstName, lastName, displayName, department, title, countryCode (ISO 3166-1 alpha-2, uppercase), city, organization, manager, employeeNumber, mobilePhone.
- status values: STAGED, PROVISIONED, ACTIVE, RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT, SUSPENDED, DEPROVISIONED. "active" = ACTIVE.
- Dates in ISO 8601 inside quotes, e.g. "2026-01-01T00:00:00.000Z".
- "columns": profile attribute names to display (without the "profile." prefix), plus "status" if relevant. Default: login, firstName, lastName, email, department, countryCode, status.
- "summary": one short English sentence describing the filter.
- If the request is ambiguous or is not a user search, return "search": null and explain in "clarification".`;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'translate') return;
  translate(msg.prompt)
    .then(plan => sendResponse({ ok: true, plan }))
    .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // async response
});

async function translate(prompt) {
  const { provider, apiKey, model } = await chrome.storage.local.get(['provider', 'apiKey', 'model']);
  if (!apiKey) throw new Error('Missing API key. Open the extension options.');

  const system = `${SYSTEM}\nToday's date: ${new Date().toISOString().slice(0, 10)}.`;
  const user = String(prompt).slice(0, 2000);
  const text = provider === 'anthropic'
    ? await callClaude(apiKey, model || 'claude-sonnet-5-5', system, user)
    : await callGemini(apiKey, model || 'gemini-2.5-flash', system, user);

  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function callGemini(apiKey, model, system, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 600, temperature: 0 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini API: HTTP ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callClaude(apiKey, model, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model, max_tokens: 600, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}
