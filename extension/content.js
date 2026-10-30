(() => {
  if (window.top !== window || document.getElementById('ait-ko-host')) return;
  // The manifest pattern matches all of *.okta.com; we only want the Admin Console.
  if (!/-admin\./.test(location.hostname)) return;

  const {
    buildRequest, nextLink, redact, getPath, show, autoColumns, csvEscape,
    matchesLocal, describeLocal, parseSteps, fillPlaceholders, describeSteps
  } = globalThis.AITKO;
  const PREVIEW_ROWS = 50;
  const MAX_ROWS = 50000;       // matching rows kept in memory
  const MAX_FETCHED = 200000;   // records scanned before stopping (matters when a local filter is used)
  const MAX_FOR_EACH = 50;      // requests a "for each" step may make

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
      pre.steps { margin: 0; padding: 8px; border: 1px solid #dde2e9; border-radius: 4px; background: #f7f9fb; white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      button.act { padding: 7px 12px; border: 1px solid #1c2430; border-radius: 4px; background: #fff; color: #1c2430; cursor: pointer; }
      button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
      button.pickItem { text-align: left; }
      button:disabled { opacity: .5; cursor: default; }
      .pickbox { padding: 10px; border: 1px solid #2f6fed; border-radius: 6px; background: #f3f7ff; display: grid; gap: 8px; }
      .pick { display: grid; gap: 6px; }
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
          <textarea id="prompt" rows="3" placeholder="e.g. active users in Finance with countryCode PT &#10;users assigned to the app Okta Admin Console &#10;failed sign-ins in the last 24 hours"></textarea>
          <div class="row"><button class="act primary" id="translate">Generate request</button></div>

          <div id="planBox" hidden>
            <div class="hint" id="summary"></div>
            <label class="small" for="expr" id="exprLabel">Request (read-only GET, editable)</label>
            <input class="q" id="expr" spellcheck="false">
            <pre class="steps" id="steps" hidden></pre>
            <div class="hint" id="local" style="margin-top:6px" hidden></div>
            <div class="row" style="margin-top:8px">
              <button class="act primary" id="run">Run</button>
              <button class="act" id="stop" hidden>Stop</button>
              <button class="act" id="csv" disabled>Export CSV</button>
              <button class="act" id="json" disabled>Export JSON</button>
            </div>
          </div>

          <div class="pickbox" id="pickBox" hidden>
            <div id="pickTitle"></div>
            <div class="pick" id="pickList"></div>
            <div class="hint" id="pickNote"></div>
          </div>

          <div id="status" class="hint" role="status"></div>
          <div class="row">
            <button class="act" id="settings" hidden>Open AiT.KO settings</button>
            <button class="act primary" id="reload" hidden>Reload page</button>
          </div>
          <div class="tbl" id="tblBox" hidden><table id="tbl"></table></div>
        </div>
      </section>
    </div>`;

  const $ = s => root.querySelector(s);
  const wrap = $('.wrap');
  let rows = [];
  let steps = [];
  let multi = false;
  let columns = [];
  let activeCols = [];
  let ctrl = null;

  $('#open').onclick = () => { wrap.classList.add('open'); $('#prompt').focus(); };
  $('#close').onclick = () => wrap.classList.remove('open');
  $('#translate').onclick = onTranslate;
  $('#run').onclick = onRun;
  $('#stop').onclick = () => ctrl && ctrl.abort();
  $('#csv').onclick = exportCsv;
  $('#json').onclick = exportJson;
  $('#settings').onclick = async () => {
    const r = await send({ type: 'openOptions' });
    if (r && r.stale) { $('#reload').hidden = false; setStatus(r.error, true); }
  };
  $('#reload').onclick = () => location.reload();
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onTranslate();
  });
  $('#expr').addEventListener('keydown', e => { if (e.key === 'Enter') onRun(); });

  function setStatus(msg, isErr = false) {
    const el = $('#status');
    el.textContent = msg;
    el.className = isErr ? 'err' : 'hint';
  }

  // After the extension is updated or reloaded, a page that was already open keeps a dead connection to it
  // ("Extension context invalidated"). Reloading the page fixes it, so say so instead of failing silently.
  async function send(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error('Extension context invalidated.');
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const text = String((e && e.message) || e);
      const stale = /context invalidated|receiving end does not exist/i.test(text);
      return { ok: false, stale, error: stale ? 'AiT.KO was updated or reloaded. Reload this page to keep using it.' : text };
    }
  }

  // ---------- Step 1: natural language -> plan ----------
  async function onTranslate() {
    const prompt = $('#prompt').value.trim();
    if (!prompt) return;
    setStatus('Generating request…');
    $('#planBox').hidden = true;
    $('#pickBox').hidden = true;
    $('#settings').hidden = true;
    $('#reload').hidden = true;
    const res = await send({ type: 'translate', prompt });
    if (!res?.ok) {
      $('#settings').hidden = !res?.code;   // key/model problems: offer a shortcut to the settings
      $('#reload').hidden = !res?.stale;    // dead connection: offer to reload the page
      return setStatus(res?.error || 'Unknown error.', true);
    }

    const plan = res.plan || {};
    const hasPlan = plan.request || (Array.isArray(plan.steps) && plan.steps.length);
    if (!hasPlan) return setStatus(plan.clarification || "Couldn't understand the request.", true);

    // The AI output is untrusted: every step is re-validated against the read-only allowlist.
    const parsed = parseSteps(plan, location.origin);
    if (parsed.error) return setStatus('The generated request was rejected: ' + parsed.error + ' Rephrase your request.', true);

    steps = parsed.steps;
    multi = steps.length > 1 || /\{\{/.test(steps[0].request);
    columns = steps[steps.length - 1].columns;
    $('#summary').textContent = [plan.summary, plan.clarification].filter(Boolean).join(' ');

    if (multi) {
      $('#exprLabel').textContent = 'Plan (read-only GET requests, run in order; ids are filled in here in your browser)';
      $('#expr').hidden = true;
      $('#steps').hidden = false;
      $('#steps').textContent = describeSteps(steps).join('\n');
      $('#local').hidden = true;
    } else {
      const built = buildRequest(steps[0].request, location.origin);   // already validated by parseSteps
      const lf = steps[0].localFilters;
      $('#exprLabel').textContent = 'Request (read-only GET, editable)';
      $('#expr').hidden = false;
      $('#steps').hidden = true;
      $('#expr').value = built.display;
      $('#local').hidden = !lf.length;
      $('#local').textContent = lf.length ? 'Then filtered in your browser: ' + describeLocal(lf) : '';
    }
    $('#planBox').hidden = false;
    setStatus(multi ? 'Review the plan, then click Run.' : 'Review the request, then click Run.');
  }

  // ---------- Step 2: run with the admin session (no API token) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plural = n => (n === 1 ? '' : 's');
  const sourceLabel = o => String(getPath(o, 'profile.name') ?? o.label ?? o.name ?? getPath(o, 'profile.login') ?? o.id ?? '');

  // Fetches every page of one request. Matching rows are pushed into "into" (so Stop keeps what was found).
  async function fetchAll(url, local, { into, decorate, label }) {
    const st = { fetched: 0, pages: 0, note: '', pageSize: Number(new URLSearchParams(url.split('?')[1]).get('limit')) };
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
        st.fetched = 1; st.pages = 1;
        if (!local.length || matchesLocal(o, local)) into.push(decorate ? decorate(o) : o);
        break;
      }
      if (data.length === 0) break;                                            // also stops /logs, whose "next" link never ends
      st.pages++;
      const page = data.map(redact);                                           // redact first, then filter locally
      st.fetched += page.length;
      const kept = local.length ? page.filter(o => matchesLocal(o, local)) : page;
      into.push(...(decorate ? kept.map(decorate) : kept));
      if (into.length >= MAX_ROWS) {
        into.length = MAX_ROWS;
        st.note = ` (stopped at the ${MAX_ROWS}-row limit; narrow the query to see the rest)`;
        break;
      }
      if (st.fetched >= MAX_FETCHED) {
        st.note = ` (stopped after scanning ${MAX_FETCHED} records; narrow the query to see the rest)`;
        break;
      }
      setStatus(`${label}${into.length} ${local.length ? 'matching rows' : 'rows'} (${st.pages} page${plural(st.pages)})…`);
      url = nextLink(r.headers.get('link'));
    }
    return st;
  }

  // Several results for a name: let the user choose, instead of guessing.
  function askPick(step, candidates) {
    return new Promise(resolve => {
      const cols = (step.columns.length ? step.columns : autoColumns(candidates)).slice(0, 4);
      const list = $('#pickList');
      const done = v => { $('#pickBox').hidden = true; ctrl && ctrl.signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => done(null);
      list.replaceChildren();
      $('#pickTitle').textContent = `Several results for "${step.name}". Which one do you mean?`;
      candidates.slice(0, 30).forEach(o => {
        const b = document.createElement('button');
        b.className = 'act pickItem';
        b.textContent = cols.map(c => show(getPath(o, c))).filter(Boolean).join(' · ') || sourceLabel(o);
        b.onclick = () => done(o);
        list.appendChild(b);
      });
      $('#pickNote').textContent = candidates.length > 30 ? `Showing the first 30 of ${candidates.length}. Refine your request to narrow them down.` : '';
      ctrl.signal.addEventListener('abort', onAbort);
      $('#pickBox').hidden = false;
      setStatus(`Waiting for you to choose one of ${candidates.length} results…`);
    });
  }

  // Runs the steps in order. Only the last step's rows are kept for display and export.
  async function runPlan(runSteps) {
    const picked = {};      // step name -> the row the user (or the only match) chose
    const collected = {};   // step name -> rows, for "for each" steps
    const agg = { fetched: 0, pages: 0, note: '', calls: 0, pageSize: 0 };

    for (let i = 0; i < runSteps.length; i++) {
      const s = runSteps[i];
      const last = i === runSteps.length - 1;
      const tag = runSteps.length > 1 ? `Step ${i + 1}/${runSteps.length}: ` : '';
      const into = last ? rows : [];

      const run = async (vars, decorate, label) => {
        const filled = fillPlaceholders(s.request, vars);
        if (filled.error) throw new Error(tag + filled.error);
        const b = buildRequest(filled.request, location.origin);      // validated again, with the real ids in place
        if (b.error) throw new Error(tag + b.error);
        const st = await fetchAll(b.url, s.localFilters, { into, decorate, label: tag + label });
        if (last) { agg.fetched += st.fetched; agg.pages += st.pages; agg.calls++; agg.pageSize = st.pageSize; agg.note = st.note || agg.note; }
      };

      if (s.forEach) {
        const src = collected[s.forEach] || [];
        if (!src.length) throw new Error(`${tag}"${s.forEach}" returned nothing, so there is nothing to repeat this step for.`);
        if (src.length > MAX_FOR_EACH) {
          throw new Error(`${tag}"${s.forEach}" returned ${src.length} results, and this step would make one request for each (maximum ${MAX_FOR_EACH}). Narrow your request.`);
        }
        for (let k = 0; k < src.length; k++) {
          await run({ ...picked, row: src[k] }, o => ({ ...o, _source: sourceLabel(src[k]) }), `${k + 1}/${src.length}: `);
          if (into.length >= MAX_ROWS) break;
        }
      } else {
        await run(picked, null, '');
      }

      if (s.pick) {
        if (!into.length) throw new Error(`${tag}Nothing found for "${s.name}". Check the name and try again.`);
        const chosen = into.length === 1 ? into[0] : await askPick(s, into);
        if (!chosen) { const e = new Error('Stopped.'); e.name = 'AbortError'; throw e; }
        picked[s.name] = chosen;
        setStatus(`${tag}using "${sourceLabel(chosen)}" (${chosen.id}).`);
      } else if (!last) {
        collected[s.name] = into;
      }
    }

    const local = runSteps[runSteps.length - 1].localFilters.length > 0;
    let msg = local
      ? `${rows.length} matching rows (scanned ${agg.fetched} in ${agg.pages} page${plural(agg.pages)})`
      : `${rows.length} rows found in ${agg.pages} page${plural(agg.pages)}`;
    msg += agg.note + '.';
    if (agg.calls === 1 && agg.pages === 1 && agg.fetched === agg.pageSize) msg += ' Okta sent no next-page link, so there may be more results.';
    return msg;
  }

  async function onRun() {
    let runSteps = steps;
    if (!multi) {
      // Re-validate whatever is in the box, since the user may have edited it.
      const built = buildRequest($('#expr').value, location.origin);
      if (built.error) return setStatus(built.error, true);
      runSteps = [{ ...steps[0], request: $('#expr').value }];
    }

    rows = [];
    ctrl = new AbortController();
    $('#csv').disabled = $('#json').disabled = true;
    $('#run').disabled = true;
    $('#stop').hidden = false;
    $('#pickBox').hidden = true;
    try {
      setStatus(await runPlan(runSteps));
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Stopped. Keeping ' + rows.length + ' rows.');
      else setStatus(String(e.message || e), true);
    } finally {
      ctrl = null;
      $('#run').disabled = false;
      $('#stop').hidden = true;
      $('#pickBox').hidden = true;
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
