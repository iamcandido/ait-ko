(() => {
  if (window.top !== window || document.getElementById('ait-ko-host')) return;
  // The manifest pattern matches all of *.okta.com; we only want the Admin Console.
  if (!/-admin\./.test(location.hostname)) return;

  const {
    buildRequest, nextLink, redact, getPath, show, autoColumns, csvEscape,
    parseLocalFilters, matchesLocal, describeLocal
  } = globalThis.AITKO;
  const PREVIEW_ROWS = 50;
  const MAX_ROWS = 50000;       // matching rows kept in memory
  const MAX_FETCHED = 200000;   // records scanned before stopping (matters when a local filter is used)

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
      .panel { display: none; width: 480px; max-width: calc(100vw - 32px); max-height: 80vh; overflow: auto; background: #fff; border: 1px solid #c5ccd6; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.25); }
      .open .panel { display: block; }
      .open .pill { display: none; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #1c2430; color: #fff; border-radius: 8px 8px 0 0; }
      header button { background: none; border: 0; color: #fff; cursor: pointer; font-size: 16px; }
      .body { padding: 12px; display: grid; gap: 10px; }
      textarea, input.q { width: 100%; padding: 8px; border: 1px solid #b8c0cc; border-radius: 4px; resize: vertical; }
      input.q { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      button.act { padding: 7px 12px; border: 1px solid #1c2430; border-radius: 4px; background: #fff; color: #1c2430; cursor: pointer; }
      button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
      button:disabled { opacity: .5; cursor: default; }
      .hint { color: #5b6675; }
      .err { color: #b3261e; }
      label.small { display: block; margin-bottom: 4px; color: #5b6675; }
      .tbl { overflow: auto; max-height: 240px; border: 1px solid #dde2e9; border-radius: 4px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { padding: 4px 8px; text-align: left; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid #eef1f5; }
      th { position: sticky; top: 0; background: #f3f5f8; }
      [hidden] { display: none !important; }
    </style>
    <div class="wrap">
      <button class="pill" id="open" aria-label="Open AiT.KO">AiT.KO</button>
      <section class="panel" aria-label="AiT.KO natural-language query">
        <header><span>AiT.KO</span><button id="close" aria-label="Minimize">&minus;</button></header>
        <div class="body">
          <textarea id="prompt" rows="3" placeholder="e.g. active users in Finance with countryCode PT &#10;apps assigned to group 00g1abc &#10;failed sign-ins in the last 24 hours"></textarea>
          <div class="row"><button class="act primary" id="translate">Generate request</button></div>

          <div id="planBox" hidden>
            <div class="hint" id="summary"></div>
            <label class="small" for="expr">Request (read-only GET, editable)</label>
            <input class="q" id="expr" spellcheck="false">
            <div class="hint" id="local" style="margin-top:6px" hidden></div>
            <div class="row" style="margin-top:8px">
              <button class="act primary" id="run">Run</button>
              <button class="act" id="stop" hidden>Stop</button>
              <button class="act" id="csv" disabled>Export CSV</button>
              <button class="act" id="json" disabled>Export JSON</button>
            </div>
          </div>

          <div id="status" class="hint" role="status"></div>
          <div class="row"><button class="act" id="settings" hidden>Open AiT.KO settings</button></div>
          <div class="tbl" id="tblBox" hidden><table id="tbl"></table></div>
        </div>
      </section>
    </div>`;

  const $ = s => root.querySelector(s);
  const wrap = $('.wrap');
  let rows = [];
  let columns = [];
  let activeCols = [];
  let localFilters = [];
  let ctrl = null;

  $('#open').onclick = () => { wrap.classList.add('open'); $('#prompt').focus(); };
  $('#close').onclick = () => wrap.classList.remove('open');
  $('#translate').onclick = onTranslate;
  $('#run').onclick = onRun;
  $('#stop').onclick = () => ctrl && ctrl.abort();
  $('#csv').onclick = exportCsv;
  $('#json').onclick = exportJson;
  $('#settings').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onTranslate();
  });
  $('#expr').addEventListener('keydown', e => { if (e.key === 'Enter') onRun(); });

  function setStatus(msg, isErr = false) {
    const el = $('#status');
    el.textContent = msg;
    el.className = isErr ? 'err' : 'hint';
  }

  // ---------- Step 1: natural language -> request ----------
  async function onTranslate() {
    const prompt = $('#prompt').value.trim();
    if (!prompt) return;
    setStatus('Generating request…');
    $('#planBox').hidden = true;
    $('#settings').hidden = true;
    const res = await chrome.runtime.sendMessage({ type: 'translate', prompt });
    if (!res?.ok) {
      $('#settings').hidden = !res?.code;   // key problems: offer a shortcut to the settings
      return setStatus(res?.error || 'Unknown error.', true);
    }

    const plan = res.plan || {};
    if (!plan.request) return setStatus(plan.clarification || "Couldn't understand the request.", true);

    // The AI output is untrusted: it is re-validated against the read-only allowlist.
    const built = buildRequest(plan.request, location.origin);
    if (built.error) return setStatus('The generated request was rejected: ' + built.error + ' Rephrase your request.', true);

    const lf = parseLocalFilters(plan.local_filter);
    if (lf.error) return setStatus('The generated request was rejected: ' + lf.error + ' Rephrase your request.', true);
    localFilters = lf.filters;
    $('#local').hidden = !localFilters.length;
    $('#local').textContent = localFilters.length ? 'Then filtered in your browser: ' + describeLocal(localFilters) : '';

    columns = (Array.isArray(plan.columns) ? plan.columns : [])
      .filter(c => typeof c === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(c))
      .slice(0, 10);
    $('#summary').textContent = [plan.summary, plan.clarification].filter(Boolean).join(' ');
    $('#expr').value = built.display;
    $('#planBox').hidden = false;
    setStatus('Review the request, then click Run.');
  }

  // ---------- Step 2: run with the admin session (no API token) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function onRun() {
    // Re-validate whatever is in the box, since the user may have edited it.
    const built = buildRequest($('#expr').value, location.origin);
    if (built.error) return setStatus(built.error, true);

    rows = [];
    ctrl = new AbortController();
    $('#csv').disabled = $('#json').disabled = true;
    $('#run').disabled = true;
    $('#stop').hidden = false;

    const local = localFilters; // snapshot for this run
    const pageSize = Number(new URLSearchParams(built.url.split('?')[1]).get('limit'));
    const plural = n => (n === 1 ? '' : 's');
    let url = built.url;
    let pages = 0;
    let fetched = 0;
    let note = '';
    const summary = () => local.length
      ? `${rows.length} matching rows (scanned ${fetched} in ${pages} page${plural(pages)})`
      : `${rows.length} rows found in ${pages} page${plural(pages)}`;
    try {
      while (url) {
        const r = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: ctrl.signal
        });
        if (r.status === 429) {
          const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000;
          setStatus('Rate limit reached, waiting…');
          await sleep(Math.max(1000, reset - Date.now() + 500));
          continue;
        }
        if (r.status === 401 || r.status === 403) throw new Error('No permission or session expired. Reload the console.');
        if (r.status === 404) throw new Error('Not found. Check the id in the request.');
        if (!r.ok) {
          let detail = '';
          try { const e = await r.json(); if (e && e.errorSummary) detail = ': ' + e.errorSummary; } catch { /* no JSON body */ }
          throw new Error('Okta returned HTTP ' + r.status + detail);
        }

        const data = await r.json();
        if (!Array.isArray(data)) {                                              // single object
          const o = redact(data);
          fetched = 1; pages = 1;
          if (!local.length || matchesLocal(o, local)) rows.push(o);
          break;
        }
        if (data.length === 0) break;                                            // also stops /logs, whose "next" link never ends
        pages++;
        const page = data.map(redact);                                           // redact first, then filter locally
        fetched += page.length;
        rows.push(...(local.length ? page.filter(o => matchesLocal(o, local)) : page));
        if (rows.length >= MAX_ROWS) {
          rows = rows.slice(0, MAX_ROWS);
          note = ` (stopped at the ${MAX_ROWS}-row limit; narrow the query to see the rest)`;
          break;
        }
        if (fetched >= MAX_FETCHED) {
          note = ` (stopped after scanning ${MAX_FETCHED} records; narrow the query to see the rest)`;
          break;
        }
        setStatus(summary() + '…');
        url = nextLink(r.headers.get('link'));
      }
      let msg = summary() + note + '.';
      if (pages === 1 && fetched === pageSize) msg += ' Okta sent no next-page link, so there may be more results.';
      setStatus(msg);
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Stopped. Keeping ' + rows.length + ' rows.');
      else setStatus(String(e.message || e), true);
    } finally {
      ctrl = null;
      $('#run').disabled = false;
      $('#stop').hidden = true;
      renderTable();
      $('#csv').disabled = $('#json').disabled = rows.length === 0;
    }
  }

  function renderTable() {
    activeCols = columns.length ? columns : autoColumns(rows);
    const tbl = $('#tbl');
    tbl.replaceChildren();
    if (!rows.length) { $('#tblBox').hidden = true; return; }
    const head = tbl.createTHead().insertRow();
    activeCols.forEach(c => { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); });
    const body = tbl.createTBody();
    rows.slice(0, PREVIEW_ROWS).forEach(o => {
      const tr = body.insertRow();
      activeCols.forEach(c => { tr.insertCell().textContent = show(getPath(o, c)); }); // textContent: data is never interpreted as HTML
    });
    $('#tblBox').hidden = false;
    if (rows.length > PREVIEW_ROWS) {
      const cur = $('#status').textContent;
      setStatus(`${cur} Previewing the first ${PREVIEW_ROWS}; exports include all rows.`);
    }
  }

  // ---------- Exports ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportCsv() {
    const lines = [activeCols.map(csvEscape).join(',')];
    rows.forEach(o => lines.push(activeCols.map(c => csvEscape(show(getPath(o, c)))).join(',')));
    download(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `ait-ko-${stamp()}.csv`);
  }

  function exportJson() {
    download(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }), `ait-ko-${stamp()}.json`);
  }
})();
