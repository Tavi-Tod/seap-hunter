/*
 * Modul GitHub Pages: înlocuiește serverul Node local.
 * Interceptează apelurile fetch('/api/...') din app.js și le rezolvă în browser:
 *  - anunțurile vin din data/notices.json (generat de GitHub Actions)
 *  - „Actualizează acum” pornește workflow-ul GitHub (necesită token salvat pe acest dispozitiv)
 *  - statusurile se salvează local și, cu token, pe ramura "user-data" din repository (sincron pe toate dispozitivele)
 *  - datele firmei pentru oferte rămân DOAR în browserul acestui dispozitiv
 */
(function () {
  const CFG = window.SEAP_STATIC;
  if (!CFG) return; // rulăm cu serverul local → nu facem nimic

  const realFetch = window.fetch.bind(window);
  const GH = 'https://api.github.com';
  const LS = {
    token: 'seapHunter.githubToken',
    statuses: 'seapHunter.statuses',
    profile: 'seapHunter.profile'
  };
  const lsGet = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stocare indisponibilă */ }
  };
  const getToken = () => lsGet(LS.token, '');

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------------
  //  Date publicate (notices.json + meta.json)
  // ------------------------------------------------------------------
  let notices = null;
  let meta = null;

  async function loadMeta() {
    const res = await realFetch(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' });
    meta = await res.json();
    return meta;
  }

  async function loadNotices(force = false) {
    if (notices && !force) return notices;
    const m = await loadMeta();
    const res = await realFetch(`data/notices.json?v=${encodeURIComponent(m.builtAt || Date.now())}`);
    notices = await res.json();
    notices._builtAt = m.builtAt;
    mergeStatuses();
    return notices;
  }

  // ------------------------------------------------------------------
  //  Statusuri: local + (opțional) GitHub, ramura user-data/statuses.json
  // ------------------------------------------------------------------
  let statuses = lsGet(LS.statuses, {});
  let remoteSha = null;

  function mergeStatuses() {
    if (!notices) return;
    for (const n of notices) {
      const s = statuses[n.code];
      n.status = (s && s.status) || 'new';
      n.notes = (s && s.notes) || '';
    }
  }

  function ghHeaders(token) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(str) {
    return decodeURIComponent(escape(atob(String(str).replace(/\s/g, ''))));
  }

  async function pullRemoteStatuses() {
    const token = getToken();
    if (!token) return false;
    const url = `${GH}/repos/${CFG.repo}/contents/statuses.json?ref=${CFG.userDataBranch}`;
    const res = await realFetch(url, { headers: ghHeaders(token), cache: 'no-store' });
    if (res.status === 404) { remoteSha = null; return true; }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const file = await res.json();
    remoteSha = file.sha;
    const remote = JSON.parse(b64decode(file.content) || '{}');
    // îmbinare: câștigă modificarea cea mai recentă
    for (const [code, s] of Object.entries(remote)) {
      const local = statuses[code];
      if (!local || (s.updatedAt || '') > (local.updatedAt || '')) statuses[code] = s;
    }
    lsSet(LS.statuses, statuses);
    mergeStatuses();
    return true;
  }

  async function pushRemoteStatuses(attempt = 0) {
    const token = getToken();
    if (!token) return false;
    const url = `${GH}/repos/${CFG.repo}/contents/statuses.json`;
    const body = {
      message: 'Actualizare statusuri anunțuri',
      content: b64encode(JSON.stringify(statuses, null, 1)),
      branch: CFG.userDataBranch
    };
    if (remoteSha) body.sha = remoteSha;
    const res = await realFetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
    if ((res.status === 409 || res.status === 422) && attempt < 2) {
      await pullRemoteStatuses(); // altcineva a scris între timp → reîncărcăm și reîncercăm
      return pushRemoteStatuses(attempt + 1);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    remoteSha = (await res.json()).content.sha;
    return true;
  }

  // ------------------------------------------------------------------
  //  „Actualizează acum” → workflow_dispatch
  // ------------------------------------------------------------------
  let runningSince = null;
  let syncPromise = null;

  async function latestRun(token) {
    const res = await realFetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/runs?per_page=1`, {
      headers: ghHeaders(token), cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.workflow_runs || [])[0] || null;
  }

  function startSync(days) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const token = getToken();
      if (!token) {
        openTokenPanel();
        throw new Error('Pentru „Actualizează acum” conectează întâi contul GitHub (butonul 🔑 GitHub).');
      }
      const before = (meta && meta.builtAt) || (await loadMeta()).builtAt;
      const res = await realFetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/dispatches`, {
        method: 'POST',
        headers: ghHeaders(token),
        body: JSON.stringify({ ref: 'main', inputs: { days: String(days || 2) } })
      });
      if (res.status === 401 || res.status === 403) throw new Error('Tokenul GitHub nu e valid sau nu are permisiunea „Actions: Read and write”.');
      if (!res.ok) throw new Error(`GitHub a refuzat pornirea actualizării (${res.status}).`);
      runningSince = Date.now();

      // așteptăm noua versiune a datelor publicată pe Pages (max ~6 minute)
      const deadline = Date.now() + 6 * 60000;
      while (Date.now() < deadline) {
        await sleep(8000);
        const m = await loadMeta().catch(() => null);
        if (m && m.builtAt && m.builtAt !== before) {
          await loadNotices(true);
          return { ...(m.lastResult || {}), success: true, liveReachable: true, timestamp: m.syncedAt };
        }
        const run = await latestRun(token).catch(() => null);
        if (run && run.status === 'completed' && run.conclusion !== 'success' && new Date(run.created_at).getTime() >= runningSince - 60000) {
          throw new Error(`Actualizarea pe GitHub a eșuat (${run.conclusion}). Detalii: ${run.html_url}`);
        }
      }
      throw new Error('Actualizarea durează mai mult decât de obicei; lista se va reîncărca automat când e gata.');
    })().finally(() => {
      runningSince = null;
      syncPromise = null;
    });
    return syncPromise;
  }

  // ------------------------------------------------------------------
  //  Router /api/*
  // ------------------------------------------------------------------
  const DEFAULT_PROFILE = {
    companyName: 'Numele firmei tale SRL',
    cui: 'RO00000000',
    regCom: 'J00/0000/2025',
    ibanTreasury: 'RO00TREZ0000000000000000',
    representative: 'Numele tău',
    email: 'email@firma.ro',
    phone: '07xx xxx xxx',
    city: ''
  };
  const getProfile = () => ({ ...DEFAULT_PROFILE, ...lsGet(LS.profile, {}) });

  function syncInfo() {
    const m = meta || {};
    return {
      lastSyncAt: m.syncedAt,
      lastFullSyncAt: m.lastFullSyncAt,
      lastResult: m.lastResult,
      running: Boolean(runningSince),
      progress: runningSince ? { done: 0, total: 1, fetched: 0, phase: 'github' } : null,
      nextAutoSyncAt: null,
      autoSyncMinutes: 30,
      totalCount: m.totalCount || (notices ? notices.length : 0),
      staticMode: true
    };
  }

  function find(id) {
    const n = (notices || []).find(x => x.code === id);
    return n ? SeapCore.buildOpportunity(n) : null;
  }

  async function route(url, init) {
    const u = new URL(url, location.href);
    const p = u.pathname.replace(/^.*\/api\//, '/api/');
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    const body = init && init.body ? JSON.parse(init.body) : {};
    const idFromPath = () => decodeURIComponent(p.split('/')[3]);

    if (method === 'GET' && (p === '/api/opportunities' || p === '/api/notices')) {
      await loadNotices();
      const filters = Object.fromEntries(u.searchParams.entries());
      const { opportunities, counts } = SeapCore.filterList(notices, filters);
      return json({ opportunities, counts, filters, totalInDatabase: notices.length, profile: getProfile(), sync: syncInfo() });
    }
    if (method === 'GET' && p === '/api/sync-status') {
      const prevBuilt = meta && meta.builtAt;
      await loadMeta().catch(() => null);
      // date noi publicate de rularea automată → reîncărcăm lista la următoarea cerere
      if (notices && meta && meta.builtAt !== prevBuilt && meta.builtAt !== notices._builtAt) notices = null;
      return json(syncInfo());
    }
    if (method === 'POST' && p === '/api/sync') {
      try {
        return json(await startSync(2)); // rapid: doar ultimele 2 zile (sincronizarea completă rulează automat)
      } catch (e) {
        return json({ success: false, liveReachable: false, error: e.message });
      }
    }
    if (method === 'PATCH' && p.endsWith('/status')) {
      await loadNotices();
      const id = idFromPath();
      const prev = statuses[id] || {};
      statuses[id] = {
        status: body.status || prev.status || 'new',
        notes: typeof body.notes === 'string' ? body.notes : (prev.notes || ''),
        updatedAt: new Date().toISOString()
      };
      lsSet(LS.statuses, statuses);
      mergeStatuses();
      if (getToken()) pushRemoteStatuses().catch(e => console.warn('Sincronizare statusuri:', e.message));
      return json({ opportunity: find(id) });
    }
    if (method === 'GET' && p.endsWith('/offer')) {
      await loadNotices();
      const opp = find(idFromPath());
      if (!opp) return json({ error: 'Anunțul nu a fost găsit' }, 404);
      const profile = getProfile();
      return json({ offer: SeapCore.generateOfferPackage(opp, profile), opportunity: opp, profile });
    }
    if (method === 'GET' && p.endsWith('/details')) {
      await loadNotices();
      const opp = find(idFromPath());
      if (opp && opp.details) return json({ details: opp.details });
      return json({ error: 'În versiunea online, condițiile sunt aduse doar pentru anunțurile IT în desfășurare. Deschide anunțul în SEAP.' }, 404);
    }
    if (p === '/api/profile') {
      if (method === 'PUT') { lsSet(LS.profile, { ...getProfile(), ...body }); }
      return json({ profile: getProfile() });
    }
    if (p === '/api/opportunities/custom' || p === '/api/import-csv') {
      return json({ error: 'Adăugarea manuală și importul CSV sunt disponibile doar în versiunea de pe laptop.' }, 400);
    }
    return json({ error: 'Necunoscut' }, 404);
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (/^\/?api\//.test(url) || url.indexOf(location.origin + '/api/') === 0) return route(url, init);
    return realFetch(input, init);
  };

  // ------------------------------------------------------------------
  //  Panou „🔑 GitHub” (token pentru Actualizează acum + statusuri sincronizate)
  // ------------------------------------------------------------------
  function openTokenPanel() {
    document.getElementById('ghTokenModal').classList.remove('hidden');
    document.getElementById('ghTokenInput').value = getToken() ? '••••••••' : '';
    renderTokenState();
  }

  function renderTokenState(msg) {
    const el = document.getElementById('ghTokenState');
    if (!el) return;
    el.textContent = msg || (getToken() ? '✅ Conectat — „Actualizează acum” și statusurile sincronizate sunt active pe acest dispozitiv.' : 'Neconectat — lista se vede, dar actualizarea manuală și sincronizarea statusurilor sunt oprite.');
  }

  function injectUI() {
    // ascundem ce nu există online
    ['btnOpenCsvModal', 'btnAddCustom'].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = 'none'; });
    const days = document.getElementById('syncDays');
    if (days) days.style.display = 'none';

    const actions = document.querySelector('.topbar-actions');
    if (actions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.id = 'btnGithubToken';
      btn.innerHTML = '<span class="icon">🔑</span> GitHub';
      btn.addEventListener('click', openTokenPanel);
      actions.appendChild(btn);
    }

    const modal = document.createElement('div');
    modal.id = 'ghTokenModal';
    modal.className = 'modal-backdrop hidden';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h2>🔑 Conectare GitHub</h2>
          <button class="modal-close" data-close-gh>✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.5">
          <p>Necesar o singură dată pe fiecare dispozitiv, ca să poți apăsa <b>„Actualizează acum”</b> și ca statusurile să fie aceleași pe telefon și laptop. Tokenul rămâne salvat doar în acest browser.</p>
          <ol style="padding-left:18px;margin:0">
            <li>Deschide <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained token nou</a>.</li>
            <li><b>Repository access</b>: <i>Only select repositories</i> → <code>${CFG.repo.split('/')[1]}</code>.</li>
            <li><b>Permissions → Repository</b>: <i>Actions</i> = Read and write, <i>Contents</i> = Read and write.</li>
            <li>Apasă <i>Generate token</i>, copiază-l și lipește-l aici.</li>
          </ol>
          <input type="password" id="ghTokenInput" class="form-input" placeholder="github_pat_..." autocomplete="off" />
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="ghTokenSave">Salvează și verifică</button>
            <button class="btn btn-outline" id="ghTokenClear">Deconectează</button>
          </div>
          <div id="ghTokenState" class="cond-muted"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal || e.target.hasAttribute('data-close-gh')) modal.classList.add('hidden'); });

    document.getElementById('ghTokenSave').addEventListener('click', async () => {
      const v = document.getElementById('ghTokenInput').value.trim();
      if (!v || v.startsWith('•')) return renderTokenState('Lipește tokenul în căsuță.');
      renderTokenState('⏳ Se verifică...');
      try {
        const res = await realFetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}`, { headers: ghHeaders(v) });
        if (!res.ok) throw new Error(res.status === 404 ? 'tokenul nu are acces la repository' : `GitHub ${res.status}`);
        lsSet(LS.token, v);
        await pullRemoteStatuses().catch(() => null);
        renderTokenState();
        if (window.loadInitialData) window.loadInitialData();
      } catch (e) {
        renderTokenState(`⚠️ Nu merge: ${e.message}. Verifică pașii 2–3.`);
      }
    });
    document.getElementById('ghTokenClear').addEventListener('click', () => {
      try { localStorage.removeItem(LS.token); } catch (e) { /* ignore */ }
      document.getElementById('ghTokenInput').value = '';
      renderTokenState();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectUI();
    if (getToken()) {
      pullRemoteStatuses().then(() => window.loadInitialData && window.loadInitialData()).catch(() => null);
    }
  });
})();
