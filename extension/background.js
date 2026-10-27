// Service worker: translates natural language -> a read-only Okta Admin API request.
// Only the text of the request goes to the AI provider (Gemini or Claude); no Okta data ever leaves the browser.

const SYSTEM = `Convert natural-language requests into ONE read-only (HTTP GET) request for the Okta Admin API.
Reply with JSON ONLY, no extra text and no markdown:
{"request": string|null, "local_filter": object[]|null, "columns": string[], "summary": string, "clarification": string|null}

"request" is a relative URL: path plus query string, for example /api/v1/groups?q=finance
Never output anything other than GET requests. If the user asks to create, change, delete, deactivate, reset, assign or otherwise modify anything, return "request": null and explain in "clarification" that this tool is read-only.

Allowed paths (replace {id} with a real id or login; never invent ids):
/api/v1/users, /api/v1/users/{id}, /api/v1/users/{id}/groups, /api/v1/users/{id}/appLinks, /api/v1/users/{id}/factors, /api/v1/users/{id}/roles
/api/v1/groups, /api/v1/groups/{id}, /api/v1/groups/{id}/users, /api/v1/groups/{id}/roles, /api/v1/groups/{id}/apps
/api/v1/apps, /api/v1/apps/{id}, /api/v1/apps/{id}/users, /api/v1/apps/{id}/groups
/api/v1/logs
/api/v1/policies (requires type, e.g. OKTA_SIGN_ON, PASSWORD, MFA_ENROLL, ACCESS_POLICY, PROFILE_ENROLLMENT), /api/v1/policies/{id}, /api/v1/policies/{id}/rules
/api/v1/authorizationServers, /api/v1/authorizationServers/{id}, /api/v1/authorizationServers/{id}/scopes|claims|policies
/api/v1/idps, /api/v1/idps/{id}, /api/v1/zones, /api/v1/zones/{id}, /api/v1/eventHooks, /api/v1/eventHooks/{id}, /api/v1/inlineHooks, /api/v1/inlineHooks/{id}
/api/v1/trustedOrigins, /api/v1/devices, /api/v1/devices/{id}, /api/v1/domains, /api/v1/org
/api/v1/meta/schemas/user/default, /api/v1/meta/schemas/group/default

Allowed query parameters ONLY: search, filter, q, limit, sortBy, sortOrder, expand, since, until, type. Never use "after".
Inside values, percent-encode & as %26, # as %23, + as %2B and % as %25 (for example "R%26D"). Spaces and double quotes may be written as is.
Filter/search syntax: attribute operator "value", combined with and / or and parentheses. Operators: eq sw gt ge lt le pr. Dates in ISO 8601 inside quotes.
IMPORTANT: Okta's user "search" has NO "ne" (not equal), NO "not", and NO way to test for an empty or missing value. Never write eq "" and never use the "filter" parameter on /api/v1/users: always use "search" there.
For conditions Okta cannot express (attribute is empty or missing; not equal, including users that have no value; does not contain), do NOT put them in "request". Put them in "local_filter" and keep "request" as narrow as possible using only supported conditions (for example status). The extension applies "local_filter" inside the browser after fetching, so it scans every record the request returns; say in "summary" that the condition is applied in the browser.
"local_filter" is null or a list of up to 5 conditions {"path": "profile.countryCode", "op": "empty" | "notempty" | "eq" | "ne" | "co" | "nco" | "sw", "value": "PT"}. Omit "value" for empty/notempty. Comparisons are case-insensitive.
Examples:
"users with an empty country code" -> {"request": "/api/v1/users", "local_filter": [{"path": "profile.countryCode", "op": "empty"}], ...}
"active users not in Portugal" -> {"request": "/api/v1/users?search=status eq \\"ACTIVE\\"", "local_filter": [{"path": "profile.countryCode", "op": "ne", "value": "PT"}], ...}

Per resource:
- users: "search" with attributes status, id, created, lastUpdated, lastLogin, statusChanged, profile.<attr> (login, email, firstName, lastName, department, title, countryCode in uppercase ISO alpha-2, city, organization, manager, employeeNumber...). status: STAGED, PROVISIONED, ACTIVE, RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT, SUSPENDED, DEPROVISIONED. "q" matches the start of first name, last name or email.
- groups: "q" matches the start of the name; "search" e.g. profile.name sw "x" or type eq "OKTA_GROUP"; expand=stats adds member counts.
- apps: "q" matches the start of name/label; "filter" e.g. status eq "ACTIVE", user.id eq "{id}", group.id eq "{id}".
- logs (system log): since/until in ISO 8601; "filter" e.g. eventType eq "user.session.start", outcome.result eq "FAILURE", actor.id eq "{id}"; "q" keywords; sortOrder ASCENDING or DESCENDING. Always set "since" for logs; if the user gives no period, use the last 24 hours.
- other resources: use "q" or "filter" only when the user asks for it.

If an {id} is needed but the user only gave a name, return the list request that lets them find the object by name and say in "summary" that they should run the next request with the id from the results.

"columns": 3 to 8 dot-paths into the JSON objects that will be returned, e.g.
users: id, profile.login, profile.firstName, profile.lastName, profile.department, profile.countryCode, status
groups: id, profile.name, profile.description, type
apps: id, label, name, status, signOnMode
logs: published, eventType, outcome.result, actor.displayName, displayMessage, client.ipAddress
"summary": one short English sentence describing what the request does.
If the request is ambiguous or unsupported, return "request": null and explain in "clarification".`;

// Only extension pages and this service worker can read chrome.storage.session; make that explicit.
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {}); } catch { /* older Chrome */ }

class KeyError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Where the key lives depends on the mode the user chose (see keystore.js).
async function getActiveKey() {
  const L = await chrome.storage.local.get(['keyMode', 'apiKey', 'encKey']);
  const mode = L.keyMode || (L.apiKey ? 'plain' : 'session');   // earlier versions kept it in local
  if (mode === 'plain') return { mode, key: L.apiKey || '', stored: !!L.apiKey };
  const S = await chrome.storage.session.get('apiKey');
  return { mode, key: S.apiKey || '', stored: mode === 'encrypted' ? !!L.encKey : false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'openOptions') { chrome.runtime.openOptionsPage(); return; }
  if (msg?.type !== 'translate') return;
  translate(msg.prompt)
    .then(plan => sendResponse({ ok: true, plan }))
    .catch(err => sendResponse({ ok: false, error: String(err.message || err), code: err.code }));
  return true; // async response
});

async function translate(prompt) {
  const { provider, model } = await chrome.storage.local.get(['provider', 'model']);
  const { mode, key: apiKey, stored } = await getActiveKey();
  if (!apiKey) {
    if (mode === 'encrypted' && stored) throw new KeyError('The API key is locked. Click the AiT.KO toolbar icon to unlock it.', 'LOCKED');
    if (mode === 'session') throw new KeyError('No API key for this browser session. Click the AiT.KO toolbar icon to enter it.', 'NO_KEY');
    throw new KeyError('Missing API key. Open the AiT.KO settings.', 'NO_KEY');
  }

  const system = `${SYSTEM}\nToday's date and time (UTC): ${new Date().toISOString()}.`;
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
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 800, temperature: 0 }
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
    body: JSON.stringify({ model, max_tokens: 800, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}
