(() => {
  if (window.top !== window || document.getElementById('ait-ko-host')) return;
  // The manifest pattern matches all of *.okta.com; we only want the Admin Console.
  if (!/-admin\./.test(location.hostname)) return;

  const DEFAULT_COLS = ['login', 'firstName', 'lastName', 'email', 'department', 'countryCode', 'status'];
  const PREVIEW_ROWS = 50;

  // ---------- UI (Shadow DOM so it doesn't clash with the console's styles) ----------
  const host = document.createElement('div');
  host.id = 'ait-ko-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; color: #1c2430; }
      .pill { display: block; padding: 7px 14px; border: 0; border-radius: 999px; background: #1c2430; color: #fff; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .pill:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
      .panel { display: none; width: 440px; max-width: calc(100vw - 32px); max-height: 80vh; overflow: auto; background: #fff; border: 1px solid #c5ccd6; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.25); }
      .open .panel { display: block; }
      .open .pill { display: none; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #1c2430; color: #fff; border-radius: 8px 8px 0 0; }
      header button { background: none; border: 0; color: #fff; cursor: pointer; font-size: 16px; }
      .body { padding: 12px; display: grid; gap: 10px; }
      textarea, input.q { width: 100%; padding: 8px; border: 1px solid #b8c0cc; border-radius: 4px; resize: vertical; }
      input.q { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
      .row { display: flex; gap: 8px; }
      button.act { padding: 7px 12px; border: 1px solid #1c2430; border-radius: 4px; background: #fff; color: #1c2430; cursor: pointer; }
      button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
      button:disabled { opacity: .5; cursor: default; }
      .hint { color: #5b6675; }
      .err { color: #b3261e; }
      .tbl { overflow: auto; max-height: 240px; border: 1px solid #dde2e9; border-radius: 4px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { padding: 4px 8px; text-align: left; white-space: nowrap; border-bottom: 1px solid #eef1f5; }
      th { position: sticky; top: 0; background: #f3f5f8; }
      [hidden] { display: none !important; }
    </style>
    <div class="wrap">
      <button class="pill" id="open" aria-label="Open AiT.KO">AiT.KO</button>
      <section class="panel" aria-label="AiT.KO natural-language query">
        <header><span>AiT.KO</span><button id="close" aria-label="Minimize">&minus;</button></header>
        <div class="body">
          <textarea id="prompt" rows="3" placeholder="e.g. active users in the Finance department with countryCode PT"></textarea>
          <div class="row"><button class="act primary" id="translate">Generate filter</button></div>

          <div id="planBox" hidden>
            <div class="hint" id="summary"></div>
            <input class="q" id="expr" aria-label="Search expression (editable)">
            <div class="row" style="margin-top:8px">
              <button class="act primary" id="run">Run</button>
              <button class="act" id="csv" disabled>Export CSV</button>
            </div>
          </div>

          <div id="status" class="hint" role="status"></div>
          <div class="tbl" id="tblBox" hidden><table id="tbl"></table></div>
        </div>
      </section>
    </div>`;

  const $ = s => root.querySelector(s);
  const wrap = $('.wrap');
  let rows = [];
  let columns = DEFAULT_COLS;

  $('#open').onclick = () => { wrap.classList.add('open'); $('#prompt').focus(); };
  $('#close').onclick = () => wrap.classList.remove('open');
  $('#translate').onclick = onTranslate;
  $('#run').onclick = onRun;
  $('#csv').onclick = exportCsv;
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onTranslate();
  });

  function setStatus(msg, isErr = false) {
    const el = $('#status');
    el.textContent = msg;
    el.className = isErr ? 'err' : 'hint';
  }

  // ---------- Validation: read-only filters over known attributes only ----------
  const ATTR = /^(status|id|created|lastUpdated|lastLogin|statusChanged|profile\.[A-Za-z0-9_]+)$/;
  const OPS = new Set(['eq', 'sw', 'co', 'gt', 'ge', 'lt', 'le', 'pr', 'and', 'or', 'not']);

  function validate(expr) {
    if (!expr || expr.length > 1000) return false;
    const bare = expr.replace(/"(?:[^"\\]|\\.)*"/g, '"S"');
    if (/[;&#]/.test(bare)) return false;
    return bare
      .replace(/[()]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .every(t => t === '"S"' || OPS.has(t) || ATTR.test(t));
  }

  // ---------- Step 1: natural language -> filter ----------
  async function onTranslate() {
    const prompt = $('#prompt').value.trim();
    if (!prompt) return;
    setStatus('Generating filter…');
    $('#planBox').hidden = true;
    const res = await chrome.runtime.sendMessage({ type: 'translate', prompt });
    if (!res?.ok) return setStatus(res?.error || 'Unknown error.', true);

    const plan = res.plan;
    if (!plan.search) return setStatus(plan.clarification || "Couldn't understand the request.", true);
    if (!validate(plan.search)) return setStatus('The generated filter was rejected for safety. Rephrase your request.', true);

    columns = (plan.columns || []).filter(c => /^[A-Za-z0-9_]+$/.test(c));
    if (!columns.length) columns = DEFAULT_COLS;
    $('#summary').textContent = plan.summary || '';
    $('#expr').value = plan.search;
    $('#planBox').hidden = false;
    setStatus('Review the filter, then click Run.');
  }

  // ---------- Step 2: run with the admin session (no API token) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function nextLink(header) {
    const m = header && header.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) return null;
    // The Link header carries the tenant domain; using a relative path keeps the request
    // on the -admin domain, where the admin session is valid.
    const u = new URL(m[1]);
    return u.pathname + u.search;
  }

  async function onRun() {
    const expr = $('#expr').value.trim();
    if (!validate(expr)) return setStatus('Invalid filter.', true);

    rows = [];
    $('#csv').disabled = true;
    $('#run').disabled = true;
    let url = '/api/v1/users?' + new URLSearchParams({ search: expr, limit: '200' });

    try {
      while (url) {
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (r.status === 429) {
          const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000;
          setStatus('Rate limit reached, waiting…');
          await sleep(Math.max(1000, reset - Date.now() + 500));
          continue;
        }
        if (r.status === 401 || r.status === 403) throw new Error('No permission or session expired. Reload the console.');
        if (!r.ok) throw new Error('Okta returned HTTP ' + r.status);
        rows.push(...(await r.json()));
        setStatus(rows.length + ' users…');
        url = nextLink(r.headers.get('link'));
      }
      setStatus(rows.length + ' users found.');
      renderTable();
      $('#csv').disabled = rows.length === 0;
    } catch (e) {
      setStatus(String(e.message || e), true);
    } finally {
      $('#run').disabled = false;
    }
  }

  const cell = (u, col) => (col === 'status' ? u.status : u.profile?.[col]) ?? '';

  function renderTable() {
    const tbl = $('#tbl');
    tbl.replaceChildren();
    const head = tbl.createTHead().insertRow();
    columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); });
    const body = tbl.createTBody();
    rows.slice(0, PREVIEW_ROWS).forEach(u => {
      const tr = body.insertRow();
      columns.forEach(c => { tr.insertCell().textContent = cell(u, c); }); // textContent: data is never interpreted as HTML
    });
    $('#tblBox').hidden = rows.length === 0;
    if (rows.length > PREVIEW_ROWS) setStatus(`${rows.length} users (previewing the first ${PREVIEW_ROWS}; the CSV has all of them).`);
  }

  // ---------- CSV ----------
  function csvEscape(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // prevents formula injection in Excel
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const lines = [columns.map(csvEscape).join(',')];
    rows.forEach(u => lines.push(columns.map(c => csvEscape(cell(u, c))).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'okta-users-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
})();
