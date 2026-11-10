let allOpportunities = [];
let companyProfile = {};
let activeCategory = 'it';
let lastCounts = {};
let totalInDatabase = 0;
const PAGE_RENDER = 120;
let renderLimit = PAGE_RENDER;

const EUR_RATE = 4.975;

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadInitialData();
  updateCalculator();
});

function copyToClipboardSafe(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}


async function loadInitialData() {
  try {
    const res = await fetch(`/api/opportunities?${buildServerQuery()}`);
    const data = await res.json();
    allOpportunities = data.opportunities || [];
    lastCounts = data.counts || {};
    totalInDatabase = data.totalInDatabase || 0;
    companyProfile = data.profile || {};
    renderSyncStatus(data.sync);
    populateProfileForm();
    renderAll();
  } catch (err) {
    console.error('Eroare la încărcarea datelor:', err);
    showBanner('⚠️ Serverul local nu răspunde: pornește-l cu start-hunter.bat sau "npm start".');
  }
}

// ---------------------------------------------------------------------------
//  Filtre trimise serverului (categorie, stare, date) — textul / statusul / sortarea se aplică local
// ---------------------------------------------------------------------------
function toISODate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildServerQuery() {
  const p = new URLSearchParams();
  p.set('scope', activeCategory);
  p.set('state', document.getElementById('stateFilter').value);
  const map = { pubFrom: 'pubFrom', pubTo: 'pubTo', dlFrom: 'dlFrom', dlTo: 'dlTo', minValue: 'minValue', maxValue: 'maxValue' };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && el.value) p.set(key, el.value);
  }
  return p.toString();
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    renderLimit = PAGE_RENDER;
    loadInitialData();
  }, 250);
}

function applyDatePreset(preset) {
  const today = new Date();
  const addDays = n => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  };
  const set = (id, v) => { document.getElementById(id).value = v || ''; };
  ['pubFrom', 'pubTo', 'dlFrom', 'dlTo'].forEach(id => set(id, ''));
  if (preset === 'pub_today') { set('pubFrom', addDays(0)); set('pubTo', addDays(0)); }
  if (preset === 'pub_3d') set('pubFrom', addDays(-2));
  if (preset === 'pub_7d') set('pubFrom', addDays(-6));
  if (preset === 'dl_3d') { set('dlFrom', addDays(0)); set('dlTo', addDays(3)); }
  if (preset === 'dl_7d') { set('dlFrom', addDays(0)); set('dlTo', addDays(7)); }
  if (preset === 'reset') {
    document.getElementById('stateFilter').value = 'active';
    document.getElementById('minValue').value = '';
    document.getElementById('maxValue').value = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('statusFilter').value = 'all';
  }
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === preset && preset !== 'reset'));
  scheduleReload();
}

function renderSyncStatus(sync) {
  const el = document.getElementById('syncStatus');
  if (!el || !sync) return;
  const fmt = iso => (iso ? new Date(iso).toLocaleString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  if (sync.running) {
    const p = sync.progress;
    if (p && p.phase === 'github') {
      el.textContent = '⏳ Actualizare pornită pe GitHub — durează de obicei 1–3 minute, lista se reîncarcă singură...';
      return;
    }
    el.textContent = p
      ? `⏳ Se descarcă anunțurile din e-licitatie.ro... ziua ${p.done}/${p.total} (${p.fetched} anunțuri până acum)`
      : '⏳ Sincronizare cu e-licitatie.ro în curs...';
    return;
  }
  const r = sync.lastResult;
  const err = r && r.error ? ` • ⚠️ Ultima eroare: ${r.error}` : '';
  el.textContent = `✅ Ultima sincronizare: ${fmt(sync.lastSyncAt)}` +
    (r && r.itCount !== undefined ? ` (${r.fetchedCount} anunțuri descărcate din ultimele ${r.days} zile, ${r.itCount} IT dintre care ${r.itActiveCount} în desfășurare)` : '') +
    (sync.staticMode
      ? ` • ${totalInDatabase} anunțuri • actualizare automată ~la 30 min`
      : ` • ${totalInDatabase} anunțuri în baza locală • Următoarea verificare: ${fmt(sync.nextAutoSyncAt)}`) + err;
}

// Reîncarcă lista automat când serverul termină o sincronizare în fundal
let lastSeenSyncAt = null;
let wasRunning = false;
async function pollSyncStatus() {
  try {
    const res = await fetch('/api/sync-status');
    const s = await res.json();
    totalInDatabase = s.totalCount || totalInDatabase;
    renderSyncStatus(s);
    const finished = (lastSeenSyncAt && s.lastSyncAt && s.lastSyncAt !== lastSeenSyncAt) || (wasRunning && !s.running);
    if (finished) {
      await loadInitialData();
      showBanner(`🔄 Lista a fost actualizată automat din e-licitatie.ro (${lastCounts.it || 0} anunțuri IT pentru filtrele curente).`);
    }
    wasRunning = Boolean(s.running);
    lastSeenSyncAt = s.lastSyncAt || lastSeenSyncAt || 'none';
    clearTimeout(window._pollTimer);
    window._pollTimer = setTimeout(pollSyncStatus, s.running ? 3000 : 20000);
  } catch (e) {
    clearTimeout(window._pollTimer);
    window._pollTimer = setTimeout(pollSyncStatus, 20000);
  }
}
setTimeout(pollSyncStatus, 1500);

function populateProfileForm() {
  if (!companyProfile) return;
  document.getElementById('profName').value = companyProfile.companyName || '';
  document.getElementById('profCui').value = companyProfile.cui || '';
  document.getElementById('profReg').value = companyProfile.regCom || '';
  document.getElementById('profIban').value = companyProfile.ibanTreasury || '';
  document.getElementById('profRep').value = companyProfile.representative || '';
  document.getElementById('profPhone').value = companyProfile.phone || '';
  document.getElementById('profEmail').value = companyProfile.email || '';
}

function normalizeSearch(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function getFilteredOpportunities() {
  const search = normalizeSearch(document.getElementById('searchInput').value.trim());
  const status = document.getElementById('statusFilter').value;
  const sort = document.getElementById('sortFilter').value;
  const terms = search.split(/\s+/).filter(Boolean);

  const filtered = allOpportunities.filter(o => {
    if (status !== 'all' && (o.status || 'new') !== status) return false;
    if (terms.length) {
      const hay = normalizeSearch(`${o.code} ${o.title} ${o.authority} ${o.cui} ${o.cpvName}`);
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });

  const time = v => (v ? new Date(v).getTime() : 0);
  filtered.sort((a, b) => {
    if (sort === 'deadline_asc') return (time(a.deadline) || 8.64e15) - (time(b.deadline) || 8.64e15);
    if (sort === 'published_desc') return time(b.publishedAt) - time(a.publishedAt);
    if (sort === 'budget_desc') return (b.estimatedValueRON || 0) - (a.estimatedValueRON || 0);
    if (sort === 'profit_desc') return (b.estimatedProfitRON || 0) - (a.estimatedProfitRON || 0);
    if (sort === 'score_desc') return (b.opportunityScore || 0) - (a.opportunityScore || 0);
    return 0;
  });

  return filtered;
}

function setCount(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || 0;
}

function renderAll() {
  setCount('countIt', lastCounts.it);
  setCount('countWeb', lastCounts.web_registratura);
  setCount('countSoft', lastCounts.software_gestiune);
  setCount('countHw', lastCounts.hardware_it);
  setCount('countKits', lastCounts.smart_lab_kits);
  setCount('countOther', lastCounts.other);
  setCount('countAll', lastCounts.all);

  const filtered = getFilteredOpportunities();

  const totalBudgetRON = filtered.reduce((s, o) => s + (o.estimatedValueRON || 0), 0);
  const totalBudgetEUR = Math.round(totalBudgetRON / EUR_RATE);
  const totalProfitRON = filtered.reduce((s, o) => s + (o.estimatedProfitRON || 0), 0);
  const totalProfitEUR = Math.round(totalProfitRON / EUR_RATE);
  const it = filtered.filter(o => o.isIT);
  const avgMargin = it.length ? Math.round(it.reduce((s, o) => s + (o.profitMarginPercent || 0), 0) / it.length) : 0;
  const stateLabel = { active: 'în desfășurare', expired: 'expirate', all: 'în total' }[document.getElementById('stateFilter').value];

  document.getElementById('kpiCount').textContent = `${filtered.length} anunțuri`;
  document.getElementById('kpiCountSub').textContent = `${stateLabel} • ${it.length} din zona IT`;
  document.getElementById('kpiBudgetRON').textContent = `${Math.round(totalBudgetRON).toLocaleString('ro-RO')} RON`;
  document.getElementById('kpiBudgetEUR').textContent = `~${totalBudgetEUR.toLocaleString('ro-RO')} EUR (valoare estimată, fără TVA)`;
  document.getElementById('kpiProfitRON').textContent = `+${totalProfitRON.toLocaleString('ro-RO')} RON`;
  document.getElementById('kpiProfitEUR').textContent = `~${totalProfitEUR.toLocaleString('ro-RO')} EUR profit estimat (orientativ)`;
  document.getElementById('kpiMargin').textContent = `${avgMargin}% marjă`;

  const grid = document.getElementById('opportunitiesGrid');
  const more = document.getElementById('loadMoreWrap');
  if (filtered.length === 0) {
    const emptyDb = totalInDatabase === 0;
    grid.innerHTML = `
      <div class="opp-card" style="grid-column: 1 / -1; text-align: center; padding: 40px;">
        <h3>${emptyDb ? 'Baza locală e goală — se descarcă anunțurile din e-licitatie.ro...' : 'Niciun anunț nu corespunde filtrelor selectate'}</h3>
        <p style="color: #9ca3af; margin-top: 8px;">${emptyDb ? 'Prima sincronizare durează ~30–60 secunde. Lista se actualizează singură.' : 'Încearcă alt interval de date, „Toate anunțurile” sau apasă „Resetează filtrele”.'}</p>
      </div>
    `;
    more.classList.add('hidden');
    return;
  }

  grid.innerHTML = filtered.slice(0, renderLimit).map(o => renderCardHTML(o)).join('');
  if (filtered.length > renderLimit) {
    more.classList.remove('hidden');
    document.getElementById('btnLoadMore').textContent = `Arată mai multe (${filtered.length - renderLimit} rămase)`;
  } else {
    more.classList.add('hidden');
  }
}

function formatDateRO(iso, withTime = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleString('ro-RO', withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDeadline(o) {
  if (o.isCancelled) return '<span class="badge-state badge-expired">🚫 Anulat</span>';
  if (!o.deadline) return '📅 Termen: nespecificat';
  const d = new Date(o.deadline);
  const diffHours = (d - new Date()) / 3600000;
  const dateStr = formatDateRO(o.deadline);
  if (diffHours < 0) return `<span class="badge-state badge-expired">⛔ Expirat</span> Termen a fost: ${dateStr}`;
  if (diffHours <= 24) return `<span class="badge-state badge-urgent">🔥 Expiră în ${Math.max(1, Math.round(diffHours))} ore</span> ${dateStr}`;
  if (diffHours <= 72) return `<span class="badge-state badge-soon">⏳ ${Math.ceil(diffHours / 24)} zile rămase</span> ${dateStr}`;
  return `<span class="badge-state badge-active">🟢 În desfășurare</span> Termen: ${dateStr}`;
}

// ---------------------------------------------------------------------------
//  Condiții de participare / caiet de sarcini (din pagina anunțului SEAP)
// ---------------------------------------------------------------------------
function textBlock(label, value, cls = '') {
  if (!value) return '';
  return `<div class="cond-item ${cls}"><span class="cond-label">${label}</span><div class="cond-text">${escapeHTML(value).replace(/\n/g, '<br>')}</div></div>`;
}

function renderDetailsHTML(o) {
  const id = escapeHTML(o.id);
  const isStatic = Boolean(window.SEAP_STATIC);
  const docUrl = isStatic
    ? (o.details && o.details.docFile ? `docs/${encodeURIComponent(o.details.docFile)}` : o.seapUrl)
    : `/api/opportunities/${encodeURIComponent(o.id)}/document`;
  const originalUrl = isStatic ? o.seapUrl : `${docUrl}?original=1`;
  if (!o.advNoticeId) {
    return `<div class="cond-panel"><span class="cond-muted">Anunț adăugat manual — nu există detalii în SEAP.</span></div>`;
  }
  const d = o.details;
  if (!d) {
    return `
      <div class="cond-panel" id="cond-${id}">
        <div class="cond-actions">
          <button type="button" class="btn btn-sm btn-secondary" onclick="loadDetails('${id}')">📋 Vezi condițiile de acceptare</button>
          <a class="btn btn-sm btn-doc" href="${docUrl}" target="_blank" rel="noopener">📄 Caiet de sarcini / specificații</a>
        </div>
      </div>`;
  }
  const contact = [
    d.county ? `📍 ${escapeHTML(d.county)}${d.city && d.city !== d.county ? `, ${escapeHTML(d.city)}` : ''}` : '',
    d.email ? `✉️ <a href="mailto:${escapeHTML(d.email)}">${escapeHTML(d.email)}</a>` : '',
    d.phone ? `📞 ${escapeHTML(d.phone)}` : '',
    d.contactPerson ? `👤 ${escapeHTML(d.contactPerson)}` : ''
  ].filter(Boolean).join(' • ');
  const more = textBlock('Descriere contract', d.contractDescription) +
    textBlock('Condiții referitoare la contract', d.contractRelatedConditions) +
    textBlock('Informații suplimentare', d.additionalInformation);

  return `
    <div class="cond-panel" id="cond-${id}">
      <div class="cond-grid">
        ${textBlock('✅ Condiții de participare', d.participationConditions || '—', 'cond-main')}
        ${textBlock('🏆 Criteriu de atribuire', d.awardCriteria || '—', 'cond-main')}
      </div>
      ${more ? `<details class="cond-more"><summary>Descriere, condiții contract și informații suplimentare</summary>${more}</details>` : ''}
      ${contact ? `<div class="cond-contact">${contact}</div>` : ''}
      <div class="cond-actions">
        ${d.hasDocument
          ? `<a class="btn btn-sm btn-doc" href="${docUrl}" target="_blank" rel="noopener" title="${escapeHTML(d.documentName || '')}">📄 Vezi caietul de sarcini</a>
             <a class="cond-link" href="${originalUrl}" ${isStatic ? 'target="_blank" rel="noopener"' : ''} title="Fișierul original, cu semnătura electronică">⬇ original semnat (${escapeHTML(d.documentName || 'document')})</a>`
          : '<span class="cond-muted">Fără document atașat în SEAP</span>'}
      </div>
    </div>`;
}

async function loadDetails(id) {
  const panel = document.getElementById(`cond-${id}`);
  if (panel) panel.innerHTML = '<span class="cond-muted">⏳ Se încarcă detaliile din SEAP...</span>';
  try {
    const res = await fetch(`/api/opportunities/${encodeURIComponent(id)}/details`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Eroare');
    const o = allOpportunities.find(x => x.id === id);
    if (o) {
      o.details = data.details;
      if (panel) panel.outerHTML = renderDetailsHTML(o);
    }
  } catch (e) {
    if (panel) panel.innerHTML = `<span class="cond-muted">⚠️ Nu s-au putut încărca detaliile: ${escapeHTML(e.message)}</span>`;
  }
}

function renderCardHTML(o) {
  const id = escapeHTML(o.id);
  const finHTML = o.isIT ? `
      <div class="fin-strip">
        <div class="fin-box">
          <span class="fin-label">Valoare estimată</span>
          <span class="fin-val text-amber">${(o.estimatedValueRON || 0).toLocaleString('ro-RO')} RON</span>
          <span class="fin-sub">~${(o.estimatedValueEUR || 0).toLocaleString('ro-RO')} EUR, fără TVA</span>
        </div>
        <div class="fin-box">
          <span class="fin-label">Cost estimat</span>
          <span class="fin-val">${(o.estimatedCostRON || 0).toLocaleString('ro-RO')} RON</span>
          <span class="fin-sub">${escapeHTML(o.executionTime || '')}</span>
        </div>
        <div class="fin-box">
          <span class="fin-label">Profit estimat (${o.profitMarginPercent || 0}%)</span>
          <span class="fin-val text-emerald">+${(o.estimatedProfitRON || 0).toLocaleString('ro-RO')} RON</span>
          <span class="fin-sub">orientativ</span>
        </div>
      </div>` : `
      <div class="fin-strip">
        <div class="fin-box">
          <span class="fin-label">Valoare estimată</span>
          <span class="fin-val text-amber">${(o.estimatedValueRON || 0).toLocaleString('ro-RO')} RON</span>
          <span class="fin-sub">~${(o.estimatedValueEUR || 0).toLocaleString('ro-RO')} EUR, fără TVA</span>
        </div>
      </div>`;

  return `
    <article class="opp-card${o.isActive ? '' : ' opp-card-expired'}">
      <div class="opp-top-row">
        <div class="badge-group">
          <span class="badge-code" title="Număr anunț SEAP">${escapeHTML(o.code)}</span>
          <span class="badge-cat">${escapeHTML(o.categoryLabel)}</span>
          ${o.isPNRR ? '<span class="badge-pnrr">🇪🇺 PNRR / Proiect</span>' : ''}
        </div>
        <span class="score-pill">${escapeHTML(o.type)}</span>
      </div>

      <h3 class="opp-title">${escapeHTML(o.title)}</h3>

      <div class="opp-authority">
        🏛️ ${escapeHTML(o.authority)}
        <span>• CUI: ${escapeHTML(o.cui || '-')} • CPV: ${escapeHTML(o.cpvName || o.cpvCode)}</span>
      </div>

      ${finHTML}

      ${renderDetailsHTML(o)}

      <div class="opp-meta-row">
        <span>${formatDeadline(o)}</span>
        <span>📢 Publicat: ${formatDateRO(o.publishedAt)}</span>
      </div>

      <div class="opp-actions-row">
        <select class="status-select-card" onchange="updateStatus('${id}', this.value)">
          <option value="new" ${o.status === 'new' ? 'selected' : ''}>🆕 Status: Nou</option>
          <option value="saved" ${o.status === 'saved' ? 'selected' : ''}>⭐ În analiză</option>
          <option value="offered" ${o.status === 'offered' ? 'selected' : ''}>📩 Ofertă trimisă</option>
          <option value="catalog_published" ${o.status === 'catalog_published' ? 'selected' : ''}>📦 Publicat în Catalog SEAP</option>
          <option value="won" ${o.status === 'won' ? 'selected' : ''}>💰 Contract câștigat</option>
        </select>

        <div class="btn-group">
          <a class="btn btn-sm btn-primary" href="${escapeHTML(o.seapUrl)}" target="_blank" rel="noopener">↗ Deschide în SEAP</a>
          <button type="button" class="btn btn-sm btn-secondary" onclick="openSEAPSearchModal('${id}')">🔗 Caută</button>
          ${o.isIT ? `<button type="button" class="btn btn-sm btn-emerald" onclick="openOfferModal('${id}')">⚡ Generează ofertă</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function getBestSeapKeyword(opp) {
  if (!opp) return 'site';
  if (opp.category === 'smart_lab_kits') {
    return 'robotica';
  }
  if (opp.category === 'web_registratura') {
    return 'site';
  }
  if (opp.title.toLowerCase().includes('arhiv')) return 'arhiva';
  if (opp.title.toLowerCase().includes('registru')) return 'registru';
  return 'registratura';
}

function openSEAPSearchModal(id) {
  const opp = allOpportunities.find(o => o.id === id);
  if (!opp) return;

  const advCode = opp.code || opp.id;
  const cpv = opp.cpvCode || '72413000-8';

  document.getElementById('seapModalBadge').textContent = `🔍 VERIFICARE ÎN SEAP • ${advCode}`;
  document.getElementById('seapModalTitle').textContent = opp.title;
  document.getElementById('seapCopyKeyword').textContent = advCode;
  document.getElementById('seapCopyCpv').textContent = cpv;

  // Build Google pre-filtered search for live SEAP / UAT / School direct acquisition notices
  const googleQuery = `"${advCode}" OR "${opp.title.slice(0, 50)}" e-licitatie`;
  document.getElementById('linkGoogleSeap').href = `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}`;

  // Auto-copy ADV code so user can immediately Ctrl+V in NR ANUNT on e-licitatie.ro
  copyToClipboardSafe(advCode);
  showBanner(`📋 Codul "${advCode}" a fost copiat! Lipește-l în căsuța "NR ANUNT" pe e-licitatie.ro (și pune DATA PUBLICARE din calendar înainte de ${formatDateRO(opp.publishedAt)})!`);

  document.getElementById('seapSearchModal').classList.remove('hidden');
}

function setupEventListeners() {
  // Category Tabs
  document.querySelectorAll('#categoryTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#categoryTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.dataset.cat;
      scheduleReload();
    });
  });

  // Filters
  // Filtre locale (instant)
  const rerender = () => { renderLimit = PAGE_RENDER; renderAll(); };
  ['searchInput', 'statusFilter', 'sortFilter'].forEach(id => {
    document.getElementById(id).addEventListener('input', rerender);
    document.getElementById(id).addEventListener('change', rerender);
  });

  // Filtre pe server: stare (în desfășurare / expirate), date, valoare
  ['stateFilter', 'pubFrom', 'pubTo', 'dlFrom', 'dlTo', 'minValue', 'maxValue'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (id !== 'stateFilter') document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      scheduleReload();
    });
  });
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyDatePreset(btn.dataset.preset));
  });
  document.getElementById('btnLoadMore').addEventListener('click', () => {
    renderLimit += PAGE_RENDER;
    renderAll();
  });

  // CPV Chip Copy
  document.querySelectorAll('.cpv-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cpv = chip.dataset.cpv;
      copyToClipboardSafe(cpv);
      showBanner(`✅ Codul CPV ${cpv} a fost copiat în clipboard! Filtrul local a fost aplicat.`);
      document.getElementById('searchInput').value = cpv;
      renderAll();
    });
  });

  // Copy buttons inside SEAP Search Modal
  document.getElementById('btnCopySeapKw').addEventListener('click', () => {
    const kw = document.getElementById('seapCopyKeyword').textContent;
    copyToClipboardSafe(kw);
    showBanner(`✅ Cuvântul cheie "${kw}" a fost copiat! Dă Ctrl+V în câmpul "Denumire contract" pe e-licitatie.ro.`);
  });

  document.getElementById('btnCopySeapCpv').addEventListener('click', () => {
    const cpv = document.getElementById('seapCopyCpv').textContent;
    copyToClipboardSafe(cpv);
    showBanner(`✅ Codul CPV "${cpv}" a fost copiat! Dă Ctrl+V în câmpul "Cod CPV" pe e-licitatie.ro.`);
  });

  // Scan Live SEAP button
  document.getElementById('btnScanLive').addEventListener('click', async () => {
    const btn = document.getElementById('btnScanLive');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Se scanează e-licitatie.ro...';
    const days = Number(document.getElementById('syncDays').value) || 30;
    showBanner(window.SEAP_STATIC
      ? '🔍 Am pornit actualizarea pe GitHub (anunțurile din ultimele 2 zile) — durează de obicei 1–3 minute...'
      : `🔍 Se descarcă toate anunțurile din „Publicitate anunțuri” (e-licitatie.ro), ultimele ${days} zile...`);
    wasRunning = true;
    setTimeout(pollSyncStatus, 1000);

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days })
      });
      const data = await res.json();
      await loadInitialData();

      if (data.liveReachable) {
        showBanner(`✅ Sincronizare reușită: ${data.fetchedCount} anunțuri descărcate, ${data.itCount} din zona IT (${data.itActiveCount} în desfășurare), +${data.addedCount} noi.`);
      } else {
        showBanner(window.SEAP_STATIC
          ? `⚠️ ${data.error || 'Actualizarea nu a reușit.'}`
          : `⚠️ Nu s-a putut contacta e-licitatie.ro${data.error ? ` (${data.error})` : ''}. Rămân anunțurile salvate local.`);
      }
      lastSeenSyncAt = data.timestamp || lastSeenSyncAt;
      pollSyncStatus();
    } catch (e) {
      showBanner('⚠️ Eroare la scanare: asigură-te că serverul este pornit prin start-hunter.bat.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHTML;
    }
  });

  // Modals Open/Close
  const btnOpenCsv = document.getElementById('btnOpenCsvModal');
  if (btnOpenCsv) {
    btnOpenCsv.addEventListener('click', () => {
      document.getElementById('csvModal').classList.remove('hidden');
    });
  }

  let selectedXlsxBase64 = '';
  const csvFileInput = document.getElementById('csvFileInput');
  if (csvFileInput) {
    csvFileInput.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const reader = new FileReader();
        reader.onload = ev => {
          const dataUrl = String(ev.target.result || '');
          selectedXlsxBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          document.getElementById('csvTextarea').value = `[Fișier Excel SEAP pregătit: ${file.name} (${Math.round(file.size / 1024)} KB) — Apasă pe butonul de mai jos!]`;
        };
        reader.readAsDataURL(file);
      } else {
        selectedXlsxBase64 = '';
        const reader = new FileReader();
        reader.onload = ev => {
          document.getElementById('csvTextarea').value = String(ev.target.result || '');
        };
        reader.readAsText(file, 'UTF-8');
      }
    });
  }

  const btnProcessCsv = document.getElementById('btnProcessCsv');
  if (btnProcessCsv) {
    btnProcessCsv.addEventListener('click', async () => {
      const csvText = document.getElementById('csvTextarea').value.trim();
      if (!selectedXlsxBase64 && !csvText) {
        showBanner('⚠️ Selectează fișierul export-....xlsx descărcat din SEAP!');
        return;
      }
      const onlyActive = document.getElementById('chkOnlyActive')
        ? document.getElementById('chkOnlyActive').checked
        : true;
      const replaceExisting = document.getElementById('chkReplaceOld')
        ? document.getElementById('chkReplaceOld').checked
        : false;

      btnProcessCsv.disabled = true;
      btnProcessCsv.textContent = '⏳ Se filtrează și se verifică termenele limită...';
      try {
        const res = await fetch('/api/import-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            xlsxBase64: selectedXlsxBase64 || undefined,
            csvText: selectedXlsxBase64 ? undefined : csvText,
            onlyActive,
            replaceExisting
          })
        });
        const data = await res.json();
        if (res.ok) {
          await loadInitialData();
          document.getElementById('csvModal').classList.add('hidden');
          if (data.importedCount === 0 && data.skippedExpired > 0) {
            showBanner(`⚠️ În acel fișier TOATE cele ${data.skippedExpired} anunțuri erau deja FINALIZATE (termen expirat)! În SEAP apasă "STERGE FILTRE" -> "FILTREAZA" (fără să scrii "site") și dă Export ca să iei anunțurile ÎN DESFĂȘURARE de azi!`);
          } else {
            showBanner(`✅ Import reușit! ${data.importedCount} anunțuri adăugate (${data.skippedExpired || 0} expirate ignorate, ${data.skippedJunk || 0} sunt non-IT — le vezi la „Toate anunțurile”).`);
          }
        } else {
          showBanner(`⚠️ Eroare la import: ${data.error || 'Format necunoscut'}`);
        }
      } catch (err) {
        showBanner('⚠️ Eroare la comunicarea cu serverul local.');
      } finally {
        btnProcessCsv.disabled = false;
        btnProcessCsv.textContent = '🚀 Extrage Doar Contractele IT/PNRR În Desfășurare';
      }
    });
  }

  document.getElementById('btnOpenCalculator').addEventListener('click', () => {
    document.getElementById('calcModal').classList.remove('hidden');
  });
  document.getElementById('btnAddCustom').addEventListener('click', () => {
    document.getElementById('addModal').classList.remove('hidden');
  });
  document.getElementById('btnOpenProfile').addEventListener('click', () => {
    populateProfileForm();
    document.getElementById('profileModal').classList.remove('hidden');
  });
  document.getElementById('btnOpenGuide').addEventListener('click', () => {
    document.getElementById('guideModal').classList.remove('hidden');
  });

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.close).classList.add('hidden');
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) backdrop.classList.add('hidden');
    });
  });

  // Smart Lab Calculator inputs
  ['calcQty', 'calcSellUnit', 'calcCostBoard', 'calcCostSensors', 'calcCostBox', 'calcShipping'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateCalculator);
  });

  // Add Custom Form
  document.getElementById('addCustomForm').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      title: document.getElementById('custTitle').value,
      code: document.getElementById('custCode').value,
      cpvCode: document.getElementById('custCpv').value,
      authority: document.getElementById('custAuthority').value,
      county: document.getElementById('custCounty').value,
      estimatedValueRON: Number(document.getElementById('custBudget').value),
      estimatedCostRON: Number(document.getElementById('custCost').value),
      description: document.getElementById('custDesc').value
    };

    const res = await fetch('/api/opportunities/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(`⚠️ ${data.error || 'Eroare la adăugare'}`);
      return;
    }
    if (data.opportunity) {
      await loadInitialData();
      document.getElementById('addModal').classList.add('hidden');
      document.getElementById('addCustomForm').reset();
      showBanner(`✅ Anunțul ${data.opportunity.code} a fost adăugat și devizul a fost calculat!`);
      openOfferModal(data.opportunity.id);
    }
  });

  // Save Profile Form
  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      companyName: document.getElementById('profName').value,
      cui: document.getElementById('profCui').value,
      regCom: document.getElementById('profReg').value,
      ibanTreasury: document.getElementById('profIban').value,
      representative: document.getElementById('profRep').value,
      phone: document.getElementById('profPhone').value,
      email: document.getElementById('profEmail').value
    };
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    companyProfile = data.profile;
    document.getElementById('profileModal').classList.add('hidden');
    showBanner('✅ Datele firmei (SRL/PFA & Trezorerie) au fost salvate! Toate ofertele generate vor folosi aceste date.');
  });

  // Copy buttons inside Offer Modal
  document.getElementById('btnCopyCatalogTitle').addEventListener('click', () => {
    const txt = document.getElementById('offerCatalogBox').textContent;
    copyToClipboardSafe(txt);
    showBanner('✅ Titlul pentru Catalogul Electronic SEAP a fost copiat!');
  });

  document.getElementById('btnCopyEmail').addEventListener('click', () => {
    const txt = document.getElementById('offerEmailTextarea').value;
    copyToClipboardSafe(txt);
    showBanner('✅ Textul emailului de ofertare a fost copiat în clipboard!');
  });

  document.getElementById('btnCopyProposal').addEventListener('click', () => {
    const txt = document.getElementById('offerProposalTextarea').value;
    copyToClipboardSafe(txt);
    showBanner('✅ Propunerea Tehnică și Devizul Financiar au fost copiate!');
  });

  document.getElementById('btnPrintProposal').addEventListener('click', () => {
    const content = document.getElementById('offerProposalTextarea').value;
    const code = document.getElementById('offerModalCode').textContent;
    const win = window.open('', '_blank');
    win.document.write(`
      <html>
        <head>
          <title>Propunere Tehnica si Financiara - ${escapeHTML(code)}</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #111; line-height: 1.5; }
            pre { white-space: pre-wrap; font-family: 'Consolas', monospace; font-size: 13px; }
          </style>
        </head>
        <body>
          <pre>${escapeHTML(content)}</pre>
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `);
    win.document.close();
  });

  // Export CSV
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
}

async function updateStatus(id, status) {
  try {
    const res = await fetch(`/api/opportunities/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Eroare');
    const idx = allOpportunities.findIndex(o => o.id === id);
    if (idx !== -1 && data.opportunity) {
      allOpportunities[idx] = data.opportunity;
    }
    showBanner(`✅ Status actualizat pentru ${id}!`);
  } catch (e) {
    console.error(e);
  }
}

async function openOfferModal(id) {
  try {
    const res = await fetch(`/api/opportunities/${encodeURIComponent(id)}/offer`);
    const data = await res.json();
    const { offer, opportunity } = data;

    document.getElementById('offerModalCode').textContent = `${opportunity.code} • CPV ${opportunity.cpvCode}`;
    document.getElementById('offerModalTitle').textContent = opportunity.title;

    document.getElementById('offerEstRON').textContent = `${opportunity.estimatedValueRON.toLocaleString('ro-RO')} RON`;
    document.getElementById('offerPriceRON').textContent = `${offer.offeredRON.toLocaleString('ro-RO')} RON (~${offer.offeredEUR.toLocaleString('ro-RO')} €)`;
    document.getElementById('offerCostRON').textContent = `${offer.estimatedCostRON.toLocaleString('ro-RO')} RON`;
    document.getElementById('offerProfitRON').textContent = `+${offer.netProfitRON.toLocaleString('ro-RO')} RON (~${offer.netProfitEUR.toLocaleString('ro-RO')} €)`;

    document.getElementById('offerCatalogBox').textContent = offer.catalogTitle;
    document.getElementById('offerEmailTextarea').value = offer.emailBody;
    document.getElementById('offerProposalTextarea').value = offer.technicalProposal;

    const mailto = `mailto:${encodeURIComponent(opportunity.contactEmail || '')}?subject=${encodeURIComponent(offer.emailSubject)}&body=${encodeURIComponent(offer.emailBody)}`;
    document.getElementById('btnMailtoLink').href = mailto;

    document.getElementById('offerModal').classList.remove('hidden');
  } catch (e) {
    console.error('Eroare la generarea ofertei:', e);
  }
}

function updateCalculator() {
  const qty = Number(document.getElementById('calcQty').value) || 1;
  const sellUnit = Number(document.getElementById('calcSellUnit').value) || 0;
  const costBoard = Number(document.getElementById('calcCostBoard').value) || 0;
  const costSensors = Number(document.getElementById('calcCostSensors').value) || 0;
  const costBox = Number(document.getElementById('calcCostBox').value) || 0;
  const shipping = Number(document.getElementById('calcShipping').value) || 0;

  const unitCost = costBoard + costSensors + costBox;
  const totalCost = qty * unitCost + shipping;
  const totalRev = qty * sellUnit;
  const netProfit = totalRev - totalCost;
  const margin = totalRev > 0 ? Math.round((netProfit / totalRev) * 100) : 0;

  document.getElementById('calcResUnitCost').textContent = `${unitCost.toLocaleString('ro-RO')} RON / kit`;
  document.getElementById('calcResTotalCost').textContent = `${totalCost.toLocaleString('ro-RO')} RON`;
  document.getElementById('calcResRevenue').textContent = `${totalRev.toLocaleString('ro-RO')} RON (~${Math.round(totalRev / EUR_RATE).toLocaleString('ro-RO')} €)`;
  document.getElementById('calcResProfit').textContent = `+${netProfit.toLocaleString('ro-RO')} RON (~${Math.round(netProfit / EUR_RATE).toLocaleString('ro-RO')} €) • ${margin}% Marjă`;
}

function exportCSV() {
  const filtered = getFilteredOpportunities();
  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const headers = ['Nr_anunt', 'Categorie', 'Titlu', 'Autoritate', 'CUI', 'CPV', 'Valoare_RON', 'Data_publicare', 'Termen_limita', 'Stare', 'Status', 'Link_SEAP'];
  const rows = filtered.map(o => [
    o.code,
    o.categoryLabel,
    o.title,
    o.authority,
    o.cui,
    o.cpvName,
    o.estimatedValueRON,
    formatDateRO(o.publishedAt),
    formatDateRO(o.deadline),
    o.isCancelled ? 'Anulat' : (o.isActive ? 'In desfasurare' : 'Expirat'),
    o.status,
    o.seapUrl
  ].map(q));

  const csv = '\uFEFF' + [headers.map(q).join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `seap-achizitii-directe-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function showBanner(msg) {
  const banner = document.getElementById('syncBanner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  clearTimeout(window._bannerTimer);
  window._bannerTimer = setTimeout(() => {
    banner.classList.add('hidden');
  }, 6500);
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Expose global handlers for inline onclick attributes
window.openSEAPSearchModal = openSEAPSearchModal;
window.openOfferModal = openOfferModal;
window.updateStatus = updateStatus;
window.loadDetails = loadDetails;
window.loadInitialData = loadInitialData;
