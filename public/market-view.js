/*
 * 📊 Piață site-uri: cumpărări directe ATRIBUITE din SEAP (site nou / mentenanță / găzduire).
 * Datele vin din /api/market (server local) sau data/market.json (GitHub Pages).
 * Format compact: c=cod DA, i=id SEAP, n=denumire, p=CPV, d=data (YYYY-MM-DD), v=valoare RON,
 *                 s=furnizor, sc=CUI furnizor, b=instituție, bc=CUI instituție, t=tip, bt=tip instituție
 */
(function () {
  const TYPE_LABEL = { nou: '🆕 Site nou', mentenanta: '🛠️ Mentenanță', gazduire: '🌐 Găzduire / domeniu', altele: '❔ Nespecificat' };
  const BUYER_LABEL = { scoala: 'Școli / grădinițe', primarie: 'Primării / UAT', alta: 'Alte instituții' };
  const DA_URL = id => `https://www.e-licitatie.ro/pub/direct-acquisition/view/${id}`;

  let market = null;
  let loading = null;
  const state = { buyer: 'scoala', months: 12, q: '', leadsLimit: 50 };

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const lei = v => `${Math.round(v || 0).toLocaleString('ro-RO')} lei`;
  const median = arr => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const fmtDate = d => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
  const monthKey = d => String(d || '').slice(0, 7);
  const monthLabel = k => new Date(`${k}-15T12:00:00`).toLocaleDateString('ro-RO', { month: 'long', year: 'numeric' });

  async function load(force) {
    if (market && !force) return market;
    if (!loading) {
      loading = fetch('/api/market').then(r => r.json()).then(m => { market = m; return m; }).finally(() => { loading = null; });
    }
    return loading;
  }

  function filtered() {
    const since = new Date();
    since.setMonth(since.getMonth() - state.months);
    const sinceKey = since.toISOString().slice(0, 10);
    const q = norm(state.q).trim();
    return (market.items || []).filter(x =>
      (x.d || '') >= sinceKey &&
      (state.buyer === 'toate' || x.bt === state.buyer) &&
      (!q || norm(`${x.b} ${x.s} ${x.n} ${x.bc}`).includes(q))
    );
  }

  // ---------------------------------------------------------------------------
  //  Clienți potențiali: instituții care plătesc găzduire/mentenanță dar n-au cumpărat site nou
  // ---------------------------------------------------------------------------
  function buildLeads(all) {
    // folosim TOATE cele ~12 luni pentru istoric, indiferent de filtrul de perioadă
    const byBuyer = new Map();
    for (const x of all) {
      const k = x.bc || x.b;
      if (!byBuyer.has(k)) byBuyer.set(k, { name: x.b, cui: x.bc, type: x.bt, items: [] });
      byBuyer.get(k).items.push(x);
    }
    const today = new Date();
    const leads = [];
    for (const b of byBuyer.values()) {
      b.items.sort((a, c) => (c.d || '').localeCompare(a.d || ''));
      const last = b.items[0];
      const lastNew = b.items.find(x => x.t === 'nou');
      const lastHost = b.items.find(x => x.t === 'gazduire');
      const lastMaint = b.items.find(x => x.t === 'mentenanta');
      const spent = b.items.reduce((s, x) => s + (x.v || 0), 0);
      const suppliers = [...new Set(b.items.map(x => x.s).filter(Boolean))];
      const reasons = [];
      let score = 0;

      if (!lastNew) {
        score += 50;
        reasons.push('n-a cumpărat site nou în ultimele 12 luni (site probabil vechi)');
      } else {
        const ageDays = (today - new Date(lastNew.d)) / 86400000;
        if (ageDays < 180) score -= 40; // tocmai și-a făcut site → nu e momentul
      }
      if (lastHost) {
        const renew = new Date(lastHost.d);
        renew.setFullYear(renew.getFullYear() + 1);
        const daysToRenew = Math.round((renew - today) / 86400000);
        if (daysToRenew >= -30 && daysToRenew <= 90) {
          score += 30;
          reasons.push(`găzduirea expiră în jur de ${renew.toLocaleDateString('ro-RO', { month: 'long', year: 'numeric' })}`);
        }
        b.renewAt = renew;
      }
      if (lastMaint && !lastNew) { score += 10; reasons.push('plătește mentenanță pentru un site existent'); }
      if (suppliers.length > 1) { score += 5; reasons.push(`a schimbat furnizorul (${suppliers.length} furnizori)`); }
      if (score <= 0) continue;
      leads.push({ ...b, last, lastNew, lastHost, lastMaint, spent, suppliers, reasons, score });
    }
    leads.sort((a, c) => c.score - a.score || (a.renewAt || 8.64e15) - (c.renewAt || 8.64e15));
    return leads;
  }

  // ---------------------------------------------------------------------------
  //  Randare
  // ---------------------------------------------------------------------------
  function render() {
    const root = document.getElementById('marketView');
    if (!market) { root.innerHTML = '<div class="opp-card">⏳ Se încarcă datele de piață...</div>'; return; }
    if (!(market.items || []).length) {
      root.innerHTML = '<div class="opp-card"><h3>Încă nu există date de piață</h3><p class="cond-muted">Prima descărcare (12 luni de cumpărări directe) durează câteva minute și rulează automat. Revino puțin mai târziu.</p></div>';
      return;
    }
    const items = filtered();
    const byType = t => items.filter(x => x.t === t).map(x => x.v).filter(v => v > 0);
    const buyers = new Set(items.map(x => x.bc || x.b));

    // pe luni
    const months = {};
    for (const x of items) {
      const k = monthKey(x.d);
      months[k] = months[k] || { total: 0, nou: 0, val: [] };
      months[k].total++;
      if (x.t === 'nou') months[k].nou++;
      if (x.v > 0) months[k].val.push(x.v);
    }
    const monthRows = Object.keys(months).sort().reverse().map(k => {
      const m = months[k];
      return `<tr><td>${esc(monthLabel(k))}</td><td class="num">${m.total}</td><td class="num">${m.nou}</td><td class="num">${lei(median(m.val))}</td></tr>`;
    }).join('');

    // furnizori
    const sup = {};
    for (const x of items) {
      const k = x.sc || x.s || '?';
      sup[k] = sup[k] || { name: x.s, cui: x.sc, n: 0, buyers: new Set(), val: [] };
      sup[k].n++;
      sup[k].buyers.add(x.bc || x.b);
      if (x.v > 0) sup[k].val.push(x.v);
    }
    const supList = Object.values(sup).sort((a, b) => b.n - a.n);
    const top8 = supList.slice(0, 8).reduce((s, x) => s + x.n, 0);
    const supRows = supList.slice(0, 15).map(s => `
      <tr><td>${esc(s.name)}<span class="cond-muted"> ${esc(s.cui)}</span></td><td class="num">${s.n}</td><td class="num">${s.buyers.size}</td><td class="num">${lei(median(s.val))}</td><td class="num">${Math.round(100 * s.n / items.length)}%</td></tr>`).join('');

    // clienți potențiali (din tot istoricul, filtrați după tipul instituției + căutare)
    const q = norm(state.q).trim();
    const allLeads = buildLeads((market.items || []).filter(x => state.buyer === 'toate' || x.bt === state.buyer))
      .filter(l => !q || norm(`${l.name} ${l.suppliers.join(' ')} ${l.cui}`).includes(q));
    const leadRows = allLeads.slice(0, state.leadsLimit).map(l => {
      const google = `https://www.google.com/search?q=${encodeURIComponent(`${l.name} site oficial contact`)}`;
      return `
      <div class="lead-card">
        <div class="lead-head">
          <b>${esc(l.name)}</b>
          <span class="cond-muted">CUI ${esc(l.cui || '-')} • ${esc(BUYER_LABEL[l.type] || '')}</span>
        </div>
        <div class="lead-reasons">${l.reasons.map(r => `<span>🎯 ${esc(r)}</span>`).join('')}</div>
        <div class="lead-last">
          Ultima: <b>${esc(TYPE_LABEL[l.last.t])}</b> — „${esc(l.last.n)}” • ${lei(l.last.v)} • ${fmtDate(l.last.d)} • furnizor: ${esc(l.last.s || '-')}
          ${l.items.length > 1 ? `<br><span class="cond-muted">${l.items.length} cumpărări web în 12 luni, total ${lei(l.spent)}</span>` : ''}
        </div>
        <div class="cond-actions">
          <a class="btn btn-sm btn-secondary" href="${google}" target="_blank" rel="noopener">🔎 Caută site / contact</a>
          <a class="cond-link" href="${DA_URL(l.last.i)}" target="_blank" rel="noopener">↗ Ultima cumpărare în SEAP (${esc(l.last.c)}) — telefon și email instituție</a>
        </div>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="market-intro">
        📊 <b>Piață site-uri</b> — cumpărări directe <b>deja atribuite</b> în SEAP (site nou, mentenanță, găzduire). Nu sunt anunțuri la care se poate oferta:
        instituțiile aleg direct oferte din <b>catalogul SEAP</b>. Aici vezi cine cumpără, de la cine, la ce preț — și pe cine merită să contactezi.
        <span class="cond-muted">Actualizat: ${market.syncedAt ? new Date(market.syncedAt).toLocaleString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</span>
      </div>

      <div class="filters-row market-filters">
        <select id="mkBuyer" class="filter-select">
          <option value="scoala">🏫 Școli / grădinițe</option>
          <option value="primarie">🏛️ Primării / UAT</option>
          <option value="alta">🏢 Alte instituții</option>
          <option value="toate">📋 Toate instituțiile</option>
        </select>
        <select id="mkMonths" class="filter-select">
          <option value="3">Ultimele 3 luni</option>
          <option value="6">Ultimele 6 luni</option>
          <option value="12">Ultimele 12 luni</option>
        </select>
        <div class="search-box"><span class="search-icon">🔍</span><input type="text" id="mkSearch" placeholder="Caută instituție, furnizor sau CUI..." /></div>
        <button id="mkExport" class="btn btn-outline btn-sm">📥 Export clienți (CSV)</button>
      </div>

      <section class="kpi-grid market-kpis">
        <div class="kpi-card"><div class="kpi-label">Cumpărări web</div><div class="kpi-value">${items.length}</div><div class="kpi-sub">${buyers.size} instituții</div></div>
        <div class="kpi-card"><div class="kpi-label">🆕 Site nou — preț median</div><div class="kpi-value">${lei(median(byType('nou')))}</div><div class="kpi-sub">${byType('nou').length} contracte</div></div>
        <div class="kpi-card"><div class="kpi-label">🛠️ Mentenanță — preț median</div><div class="kpi-value">${lei(median(byType('mentenanta')))}</div><div class="kpi-sub">${byType('mentenanta').length} contracte</div></div>
        <div class="kpi-card"><div class="kpi-label">🌐 Găzduire — preț median</div><div class="kpi-value">${lei(median(byType('gazduire')))}</div><div class="kpi-sub">${byType('gazduire').length} contracte</div></div>
      </section>

      <div class="market-grid">
        <section class="opp-card market-leads">
          <h3>🎯 Clienți potențiali <span class="tab-count">${allLeads.length}</span></h3>
          <p class="cond-muted">Instituții care plătesc găzduire / mentenanță dar n-au cumpărat site nou în ultimul an, sau cărora le expiră găzduirea în următoarele ~3 luni. Sună-i, spune-le că ai oferta în catalogul SEAP și dă-le codul ei.</p>
          ${leadRows || '<p class="cond-muted">Niciun client potențial pentru filtrele alese.</p>'}
          ${allLeads.length > state.leadsLimit ? `<div class="load-more-wrap"><button class="btn btn-secondary" id="mkMore">Arată mai mulți (${allLeads.length - state.leadsLimit} rămași)</button></div>` : ''}
        </section>

        <div class="market-side">
          <section class="opp-card">
            <h3>🏆 Cine câștigă</h3>
            <p class="cond-muted">${supList.length} furnizori diferiți; primii 8 au ${items.length ? Math.round(100 * top8 / items.length) : 0}% din contracte.</p>
            <div class="table-wrap"><table class="market-table">
              <thead><tr><th>Furnizor</th><th class="num">Contracte</th><th class="num">Instituții</th><th class="num">Preț median</th><th class="num">Cotă</th></tr></thead>
              <tbody>${supRows}</tbody>
            </table></div>
          </section>

          <section class="opp-card">
            <h3>📅 Pe luni</h3>
            <div class="table-wrap"><table class="market-table">
              <thead><tr><th>Luna</th><th class="num">Cumpărări</th><th class="num">Site nou</th><th class="num">Preț median</th></tr></thead>
              <tbody>${monthRows}</tbody>
            </table></div>
          </section>
        </div>
      </div>`;

    const buyerSel = document.getElementById('mkBuyer');
    const monthsSel = document.getElementById('mkMonths');
    const search = document.getElementById('mkSearch');
    buyerSel.value = state.buyer;
    monthsSel.value = String(state.months);
    search.value = state.q;
    buyerSel.addEventListener('change', () => { state.buyer = buyerSel.value; state.leadsLimit = 50; render(); });
    monthsSel.addEventListener('change', () => { state.months = Number(monthsSel.value); render(); });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.q = search.value;
        state.leadsLimit = 50;
        render();
        const s = document.getElementById('mkSearch');
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }, 300);
    });
    const more = document.getElementById('mkMore');
    if (more) more.addEventListener('click', () => { state.leadsLimit += 50; render(); });
    document.getElementById('mkExport').addEventListener('click', () => exportLeads(allLeads));
  }

  function exportLeads(leads) {
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Institutie', 'CUI', 'Tip', 'Motive', 'Ultima_cumparare', 'Tip_ultima', 'Valoare_ultima', 'Data_ultima', 'Furnizor_actual', 'Total_12_luni', 'Link_SEAP'];
    const rows = leads.map(l => [l.name, l.cui, BUYER_LABEL[l.type], l.reasons.join('; '), l.last.n, TYPE_LABEL[l.last.t], l.last.v, l.last.d, l.last.s, Math.round(l.spent), DA_URL(l.last.i)].map(q).join(','));
    const csv = '﻿' + [head.map(q).join(','), ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `clienti-potentiali-site-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ---------------------------------------------------------------------------
  //  Comutare între „Anunțuri” și „Piață”
  // ---------------------------------------------------------------------------
  function show(on) {
    document.body.classList.toggle('market-mode', on);
    const btn = document.getElementById('btnMarket');
    if (btn) btn.innerHTML = on ? '<span class="icon">📋</span> Anunțuri' : '<span class="icon">📊</span> Piață site-uri';
    try { localStorage.setItem('seapHunter.view', on ? 'market' : 'notices'); } catch (e) { /* ignore */ }
    if (on) {
      render();
      load().then(render).catch(e => {
        document.getElementById('marketView').innerHTML = `<div class="opp-card">⚠️ Nu s-au putut încărca datele de piață: ${esc(e.message)}</div>`;
      });
      window.scrollTo(0, 0);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const actions = document.querySelector('.topbar-actions');
    const btn = document.createElement('button');
    btn.id = 'btnMarket';
    btn.className = 'btn btn-secondary btn-market';
    btn.addEventListener('click', () => show(!document.body.classList.contains('market-mode')));
    actions.insertBefore(btn, actions.children[1] || null);
    let saved = 'notices';
    try { saved = localStorage.getItem('seapHunter.view') || 'notices'; } catch (e) { /* ignore */ }
    show(saved === 'market');
  });

  window.SeapMarket = { reload: () => load(true).then(render) };
})();
