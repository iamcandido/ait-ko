// Pure helpers (no DOM access) so they can be unit-tested outside the browser.
// Everything the AI provider returns is treated as untrusted and re-validated here.
(() => {
  'use strict';

  const MAX_LIMIT = 200;
  const ID = '[A-Za-z0-9_.@+-]{1,128}';

  // Read-only allowlist of Okta Admin API resources. Anything else is rejected.
  const ALLOWED_PATHS = [
    'users', `users/${ID}`, `users/${ID}/(?:groups|appLinks|factors|roles)`,
    'groups', `groups/${ID}`, `groups/${ID}/(?:users|roles|apps)`,
    'apps', `apps/${ID}`, `apps/${ID}/(?:users|groups)`,
    'logs',
    'policies', `policies/${ID}`, `policies/${ID}/rules`,
    'authorizationServers', `authorizationServers/${ID}`, `authorizationServers/${ID}/(?:scopes|claims|policies)`,
    'idps', `idps/${ID}`,
    'zones', `zones/${ID}`,
    'eventHooks', `eventHooks/${ID}`,
    'inlineHooks', `inlineHooks/${ID}`,
    'trustedOrigins', 'devices', `devices/${ID}`, 'domains', 'org',
    'meta/schemas/(?:user|group)/default'
  ].map(p => new RegExp('^/api/v1/' + p + '$'));

  const OPS = new Set(['eq', 'sw', 'co', 'gt', 'ge', 'lt', 'le', 'pr', 'and', 'or', 'not']);
  const ATTR = /^[A-Za-z_][A-Za-z0-9_.]*$/;
  const NUM = /^-?\d+(\.\d+)?$/;
  const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/;

  // Okta filter/search expression: attribute operator "value", joined by and/or/not.
  function validExpr(expr) {
    if (typeof expr !== 'string' || !expr || expr.length > 1000 || /[\u0000-\u001f]/.test(expr)) return false;
    const bare = expr.replace(/"(?:[^"\\]|\\.)*"/g, '"S"');
    if (/["';&#]/.test(bare.replace(/"S"/g, ''))) return false;
    return bare.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean).every(t =>
      t === '"S"' || OPS.has(t) || NUM.test(t) || t === 'true' || t === 'false' || ATTR.test(t));
  }

  // Okta's user `search` has no "ne" operator (HTTP 400). Its documented equivalent is
  // (attr lt "X" or attr gt "X"). Quoted strings are skipped so values are never touched.
  // Note: users whose attribute is empty do not match lt/gt, so they are not returned.
  function rewriteNe(expr) {
    return expr.replace(
      /("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.]*)\s+ne\s+("(?:[^"\\]|\\.)*")/g,
      (m, quoted, attr, val) => (quoted ? quoted : `(${attr} lt ${val} or ${attr} gt ${val})`)
    );
  }

  const noCtl = v => /^[^\u0000-\u001f]{1,200}$/.test(v);
  const PARAMS = {
    search: validExpr,
    filter: validExpr,
    q: noCtl,
    limit: v => /^\d{1,4}$/.test(v) && Number(v) >= 1,
    sortBy: v => /^[A-Za-z0-9_.]{1,64}$/.test(v),
    sortOrder: v => /^[A-Za-z]{3,10}$/.test(v),
    expand: v => /^[A-Za-z0-9_,]{1,64}$/.test(v),
    since: v => ISO.test(v),
    until: v => ISO.test(v),
    type: v => /^[A-Za-z0-9_]{1,64}$/.test(v)
    // "after" is deliberately absent: pagination is handled by the extension via the Link header.
  };

  // Keeps spaces and quotes readable, but escapes the characters that would break re-parsing.
  const readable = v => v.replace(/[%&#+]/g, c => encodeURIComponent(c));

  // Turns an untrusted "path?query" string into a validated, normalized request.
  function buildRequest(raw, origin) {
    let u;
    try { u = new URL(String(raw).trim(), origin); } catch { return { error: 'Not a valid URL.' }; }
    if (u.origin !== origin) return { error: 'The request must stay on this Okta org.' };
    if (!ALLOWED_PATHS.some(re => re.test(u.pathname))) return { error: 'That API path is not on the read-only allowlist.' };

    const out = new URLSearchParams();
    for (let [k, v] of u.searchParams) {
      if (!Object.prototype.hasOwnProperty.call(PARAMS, k)) return { error: `Parameter "${k}" is not allowed.` };
      if (k === 'search') v = rewriteNe(v);
      if (out.has(k)) return { error: `Duplicate parameter "${k}".` };
      if (!PARAMS[k](v)) return { error: `Invalid value for "${k}".` };
      out.set(k, v);
    }
    out.set('limit', String(Math.min(Number(out.get('limit') || MAX_LIMIT), MAX_LIMIT)));

    // "limit" is only the page size (Okta's maximum per call); pagination fetches everything.
    // The default is not shown, so it doesn't look like a cap on the results.
    const shown = [...out]
      .filter(([k, v]) => !(k === 'limit' && Number(v) === MAX_LIMIT))
      .map(([k, v]) => `${k}=${readable(v)}`)
      .join('&');
    return {
      url: u.pathname + '?' + out.toString(),
      display: u.pathname + (shown ? '?' + shown : '')
    };
  }

  // Next page from the Link header, as a relative path (keeps the call on the -admin domain).
  function nextLink(header) {
    const m = header && header.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) return null;
    try {
      const u = new URL(m[1]);
      return u.pathname.startsWith('/api/v1/') ? u.pathname + u.search : null;
    } catch { return null; }
  }

  // Defence in depth: never display or export values that look like secrets.
  const SECRET_KEY = /secret|password|passcode|private.?key|api.?key|^token$|access.?token|refresh.?token/i;
  function redact(v) {
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        o[k] = SECRET_KEY.test(k) && x !== null && typeof x !== 'boolean' ? '[redacted]' : redact(x);
      }
      return o;
    }
    return v;
  }

  const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const show = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  function autoColumns(rows) {
    const first = rows.find(r => r && typeof r === 'object') || {};
    const cols = Object.keys(first).filter(k => first[k] === null || typeof first[k] !== 'object');
    return (cols.length ? cols : Object.keys(first)).slice(0, 8);
  }

  function csvEscape(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // prevents formula injection in Excel
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ---- Local (in-browser) filters, for conditions Okta cannot express server-side ----
  // (empty/missing values, "not equal" that includes empty values, "does not contain", ...).
  // They are applied to each page after it is fetched, on already-redacted data.
  const LOCAL_OPS = new Set(['empty', 'notempty', 'eq', 'ne', 'co', 'nco', 'sw']);
  const LOCAL_LABEL = {
    empty: 'is empty', notempty: 'is not empty', eq: 'equals', ne: 'is not',
    co: 'contains', nco: 'does not contain', sw: 'starts with'
  };

  function parseLocalFilters(list) {
    if (list == null) return { filters: [] };
    if (!Array.isArray(list) || list.length > 5) return { error: 'Invalid local filter.' };
    const filters = [];
    for (const f of list) {
      if (!f || typeof f !== 'object') return { error: 'Invalid local filter.' };
      if (typeof f.path !== 'string' || !/^[A-Za-z0-9_.]{1,80}$/.test(f.path)) return { error: 'Invalid local filter path.' };
      if (!LOCAL_OPS.has(f.op)) return { error: `Local filter operator "${f.op}" is not supported.` };
      if (f.op === 'empty' || f.op === 'notempty') {
        filters.push({ path: f.path, op: f.op });
      } else {
        if (typeof f.value !== 'string' || f.value.length > 200) return { error: 'Invalid local filter value.' };
        filters.push({ path: f.path, op: f.op, value: f.value });
      }
    }
    return { filters };
  }

  const isEmpty = v => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

  function matchesLocal(obj, filters) {
    return filters.every(({ path, op, value }) => {
      const v = getPath(obj, path);
      if (op === 'empty') return isEmpty(v);
      if (op === 'notempty') return !isEmpty(v);
      const a = show(v).toLowerCase();   // comparisons are case-insensitive
      const b = value.toLowerCase();
      if (op === 'eq') return a === b;
      if (op === 'ne') return a !== b;   // users with no value also count as "not equal"
      if (op === 'co') return a.includes(b);
      if (op === 'nco') return !a.includes(b);
      if (op === 'sw') return a.startsWith(b);
      return false;
    });
  }

  const describeLocal = filters =>
    filters.map(f => `${f.path} ${LOCAL_LABEL[f.op]}${f.value !== undefined ? ` "${f.value}"` : ''}`).join(' and ');

  // ---- Multi-step plans ----
  // Some questions need several requests ("users assigned to the app named X": find the app, then list its users).
  // The AI provider plans the steps from the question alone and never sees any result: ids are filled in here,
  // in the browser, and every resulting request is validated again against the read-only allowlist.
  const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,20})\.([A-Za-z0-9_.]{1,80})\s*\}\}/g;
  const NAME_RE = /^[a-z][a-z0-9_]{0,20}$/;
  const SAFE_VALUE = /^[A-Za-z0-9_.@+-]{1,128}$/;
  const MAX_STEPS = 4;

  const cleanColumns = list =>
    (Array.isArray(list) ? list : []).filter(c => typeof c === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(c)).slice(0, 10);

  // plan: {request, local_filter, columns} for one request, or {steps: [...]} for several.
  function parseSteps(plan, origin) {
    let raw;
    if (plan && Array.isArray(plan.steps) && plan.steps.length) raw = plan.steps;
    else if (plan && typeof plan.request === 'string' && plan.request) raw = [{ request: plan.request, local_filter: plan.local_filter, columns: plan.columns }];
    else return { error: 'The plan has no request.' };
    if (raw.length > MAX_STEPS) return { error: `The plan has too many steps (maximum ${MAX_STEPS}).` };

    const steps = [];
    const names = new Map();   // name -> { pick }
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const last = i === raw.length - 1;
      const fail = msg => ({ error: raw.length > 1 ? `Step ${i + 1}: ${msg}` : msg });
      if (!s || typeof s !== 'object' || typeof s.request !== 'string' || !s.request) return fail('it has no request.');

      const lf = parseLocalFilters(s.local_filter);
      if (lf.error) return fail(lf.error);

      let name = null;
      if (s.name != null) {
        if (typeof s.name !== 'string' || !NAME_RE.test(s.name) || s.name === 'row' || names.has(s.name)) return fail('its name is invalid or repeated.');
        name = s.name;
      }
      if (!last && !name) return fail('it needs a name, because a later step uses it.');

      const pick = s.pick === true;
      if (pick && last) return fail('the last step cannot be a "pick" step.');

      let forEach = null;
      if (s.for_each != null) {
        if (typeof s.for_each !== 'string' || !names.has(s.for_each) || names.get(s.for_each).pick) return fail('"for_each" must name an earlier step that lists several rows.');
        if (pick) return fail('a step cannot be both "pick" and "for_each".');
        forEach = s.for_each;
      }

      for (const m of s.request.matchAll(PLACEHOLDER)) {
        const ref = m[1];
        if (ref === 'row') { if (!forEach) return fail('it uses {{row.…}} without "for_each".'); }
        else if (!names.has(ref) || !names.get(ref).pick) return fail(`it refers to "${ref}", which is not an earlier "pick" step.`);
      }
      if (forEach && !/\{\{\s*row\./.test(s.request)) return fail('"for_each" needs {{row.…}} in the request.');

      // Dry run: with a harmless id in place of every placeholder, the request must pass the full validation.
      const dryRequest = s.request.replace(PLACEHOLDER, 'x0');
      if (/\{\{|\}\}/.test(dryRequest)) return fail('it contains a malformed placeholder.');
      const dry = buildRequest(dryRequest, origin);
      if (dry.error) return fail(dry.error);

      steps.push({ name, request: s.request, localFilters: lf.filters, columns: cleanColumns(s.columns), pick, forEach });
      if (name) names.set(name, { pick });
    }
    return { steps };
  }

  // vars: { stepName: row, row: row }. Only plain id-like values are allowed to end up in a URL.
  function fillPlaceholders(template, vars) {
    let error = null;
    const request = template.replace(PLACEHOLDER, (m, ref, path) => {
      if (error) return m;
      const row = Object.prototype.hasOwnProperty.call(vars, ref) ? vars[ref] : undefined;
      const v = row === undefined ? undefined : getPath(row, path);
      const text = v == null || typeof v === 'object' ? '' : String(v);
      if (!SAFE_VALUE.test(text) || text === '.' || text === '..') {
        error = `Cannot use "${path}" from "${ref}": the value is empty or contains characters that are not allowed.`;
        return m;
      }
      return text;
    });
    if (!error && /\{\{|\}\}/.test(request)) error = 'The request contains a malformed placeholder.';
    return error ? { error } : { request };
  }

  const describeSteps = steps => steps.map((s, i) =>
    `${i + 1}. ${s.request}` +
    (s.pick ? '  → you choose one result' : '') +
    (s.forEach ? `  → once for each result of "${s.forEach}"` : '') +
    (s.localFilters.length ? `  → then filtered in your browser: ${describeLocal(s.localFilters)}` : ''));

  const api = {
    rewriteNe, buildRequest, nextLink, redact, getPath, show, autoColumns, csvEscape, validExpr,
    parseLocalFilters, matchesLocal, describeLocal,
    parseSteps, fillPlaceholders, describeSteps
  };
  globalThis.AITKO = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
