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

  const api = { rewriteNe, buildRequest, nextLink, redact, getPath, show, autoColumns, csvEscape, validExpr };
  globalThis.AITKO = api;
  if (typeof module !== 'undefined') module.exports = api;
})();