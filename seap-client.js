const fs = require('fs');
const path = require('path');

// ============================================================================
//  Configurare
// ============================================================================
const DATA_DIR = process.env.SEAP_DATA_DIR ? path.resolve(process.env.SEAP_DATA_DIR) : path.join(__dirname, 'data');
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');          // TOATE anunțurile descărcate (IT + non-IT)
const LEGACY_DB_FILE = path.join(DATA_DIR, 'opportunities.json');  // format vechi (doar pentru migrare)
const PROFILE_FILE = path.join(DATA_DIR, 'company-profile.json');
const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync-state.json');


// Endpoint-ul public SEAP pentru "Publicitate Anunțuri" (anunțuri ADV la care se poate oferta).
const ADV_LIST_URL = 'https://www.e-licitatie.ro/api-pub/AdvNoticeCommon/GetAdvNoticeList/';
const { SEAP_PUBLIC_ADV_PAGE, SEAP_ADV_VIEW_URL } = require('./public/core.js');
const PAGE_SIZE = 500;          // SEAP acceptă maxim ~500/pagină și 2000 rezultate per căutare
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const RETENTION_DAYS = 90;      // anunțurile expirate mai vechi de atât se șterg din baza locală

const SEAP_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json;charset=UTF-8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://www.e-licitatie.ro',
  'Referer': SEAP_PUBLIC_ADV_PAGE // obligatoriu: fără Referer API-ul răspunde "Access Denied"
};

// Statusuri setate de utilizator care NU se șterg automat la curățare
const KEEP_STATUSES = new Set(['saved', 'offered', 'catalog_published', 'won']);

// ============================================================================
//  Bază de date (fișiere JSON)
// ============================================================================
const DEFAULT_PROFILE = {
  companyName: 'SC SMART DIGITAL SOLUTIONS SRL (sau PFA-ul tău)',
  cui: 'RO49812345',
  regCom: 'J40/1234/2025',
  ibanTreasury: 'RO49TREZ7015069XXX012345 (Trezoreria Statului)',
  representative: 'Ing. Automatizări & Calculatoare',
  email: 'office@smartdigitalsolutions.ro',
  phone: '0740 123 456',
  city: 'București / Cluj / Iași / Timișoara'
};

function readJSON(file, fallback) {
  try {
    // eliminăm BOM-ul eventual (fișiere salvate din PowerShell / Notepad)
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data, pretty = true) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
  fs.renameSync(tmp, file); // scriere atomică: nu corupem DB-ul dacă procesul se oprește la mijloc
}

function ensureDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILE_FILE)) writeJSON(PROFILE_FILE, DEFAULT_PROFILE);
  if (!fs.existsSync(NOTICES_FILE)) {
    // Migrare din formatul vechi: păstrăm doar înregistrările valide la care utilizatorul a lucrat
    const legacy = readJSON(LEGACY_DB_FILE, []);
    const migrated = (Array.isArray(legacy) ? legacy : [])
      .filter(o => o && o.id && !/^DA\d+/.test(o.id) && o.authority !== '[object Object]')
      .filter(o => KEEP_STATUSES.has(o.status) || (o.notes && o.notes.trim()))
      .map(o => ({
        code: o.code || o.id,
        advNoticeId: o.advNoticeId || null,
        title: o.title,
        authority: o.cui && o.cui !== '-' ? `${o.cui} ${o.authority}` : o.authority,
        cpvFull: o.cpvName || o.cpvCode || '',
        publishedAt: o.publishedAt || null,
        deadline: o.deadline || null,
        valueRON: o.estimatedValueRON || 0,
        contractType: '',
        noticeType: o.type || '',
        status: o.status,
        notes: o.notes || '',
        manual: true
      }));
    writeJSON(NOTICES_FILE, migrated, false);
  }
}

/** Lista brută de anunțuri (format compact). */
function getNotices() {
  ensureDatabase();
  const list = readJSON(NOTICES_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveNotices(list) {
  ensureDatabase();
  writeJSON(NOTICES_FILE, list, false);
}

function getCompanyProfile() {
  ensureDatabase();
  return { ...DEFAULT_PROFILE, ...readJSON(PROFILE_FILE, {}) };
}

function saveCompanyProfile(profile) {
  const updated = { ...getCompanyProfile(), ...profile };
  writeJSON(PROFILE_FILE, updated);
  return updated;
}

function getSyncState() {
  return readJSON(SYNC_STATE_FILE, { lastSyncAt: null, lastFullSyncAt: null, lastResult: null });
}

function saveSyncState(state) {
  ensureDatabase();
  writeJSON(SYNC_STATE_FILE, state);
}

// Logica comună (clasificare IT, construire carduri, filtrare, oferte) — folosită și în browser
const core = require('./public/core.js');
const {
  CATEGORY_META, IT_CATEGORIES, normalizeText, detectCategory, isCancelledTitle,
  classifyOpportunity, buildOpportunity, filterList
} = core;

function filterNotices(f = {}) {
  return filterList(getNotices(), f);
}

function generateOfferPackage(opp, profile) {
  return core.generateOfferPackage(opp, profile || getCompanyProfile());
}

function getOpportunities(filters = {}) {
  return filterNotices(filters).opportunities;
}

function findOpportunity(id) {
  const n = getNotices().find(x => x.code === id);
  return n ? buildOpportunity(n) : null;
}

/** Actualizează câmpurile setate de utilizator (status, notițe). */
function updateNoticeUserFields(id, { status, notes }) {
  const list = getNotices();
  const n = list.find(x => x.code === id);
  if (!n) return null;
  if (status) n.status = status;
  if (typeof notes === 'string') n.notes = notes;
  saveNotices(list);
  return buildOpportunity(n);
}

/**
 * Adaugă anunțuri (manual / import CSV). Nu suprascrie ce există deja.
 * @returns {number} câte au fost adăugate
 */
function addNotices(newNotices, { replaceManual = false } = {}) {
  let list = getNotices();
  if (replaceManual) list = list.filter(n => !n.manual || KEEP_STATUSES.has(n.status));
  const existing = new Set(list.map(n => n.code));
  let added = 0;
  for (const n of newNotices) {
    if (!n.code || existing.has(n.code)) continue;
    n.category = n.category || detectCategory(n.title, n.cpvFull) || 'other';
    n.firstSeenAt = n.firstSeenAt || new Date().toISOString();
    list.push(n);
    existing.add(n.code);
    added++;
  }
  saveNotices(list);
  return added;
}

// ============================================================================
//  Apeluri API SEAP
// ============================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postJSON(url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: SEAP_HEADERS,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      if (data && data.message && !data.items) throw new Error(data.message);
      return data;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`Timeout ${REQUEST_TIMEOUT_MS / 1000}s`) : err;
      if (attempt < MAX_RETRIES) await sleep(1500 * attempt); // reîncercare cu pauză crescătoare
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function dayWindows(days) {
  const windows = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const start = new Date(today.getTime() - i * 86400000);
    start.setHours(0, 0, 0, 0); // corect și la schimbarea orei de vară/iarnă
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    windows.push({ start, end });
  }
  return windows;
}

/**
 * Descarcă TOATE anunțurile de publicitate publicate în ultimele `days` zile.
 * Interogăm zi cu zi pentru a nu depăși limita SEAP de 2000 rezultate / căutare;
 * dacă o zi tot depășește limita, o împărțim pe ore.
 */
async function fetchWindow(start, end, byCode, logs) {
  let pageIndex = 0;
  let total = 0;
  let truncated = false;
  do {
    const data = await postJSON(ADV_LIST_URL, {
      pageSize: PAGE_SIZE,
      pageIndex,
      publicationDateStart: start.toISOString(),
      publicationDateEnd: end.toISOString()
    });
    const items = data.items || [];
    total = data.total || 0;
    if (pageIndex === 0 && (data.searchTooLong || total > 2000)) { truncated = true; break; }
    for (const it of items) if (it.noticeNo) byCode.set(it.noticeNo, it);
    if (items.length < PAGE_SIZE) break;
    pageIndex++;
  } while (pageIndex * PAGE_SIZE < total);

  if (truncated) {
    const span = end - start;
    if (span <= 3600000) {
      logs.push(`⚠️ ${start.toLocaleString('ro-RO')}: SEAP a trunchiat rezultatele (>2000 într-o oră)`);
      return total;
    }
    const mid = new Date(start.getTime() + Math.floor(span / 2));
    await fetchWindow(start, mid, byCode, logs);
    await fetchWindow(new Date(mid.getTime() + 1), end, byCode, logs);
  }
  return total;
}

async function fetchAdvNotices(days, logs, onProgress) {
  const byCode = new Map();
  const windows = dayWindows(days);
  let i = 0;
  for (const { start, end } of windows) {
    const total = await fetchWindow(start, end, byCode, logs);
    logs.push(`📥 ${start.toLocaleDateString('ro-RO')}: ${total} anunțuri publicate`);
    i++;
    if (onProgress) onProgress({ done: i, total: windows.length, fetched: byCode.size });
  }
  return [...byCode.values()];
}

function rawToNotice(raw) {
  return {
    code: raw.noticeNo,
    advNoticeId: raw.advNoticeId,
    title: String(raw.contractObject || '').replace(/\s+/g, ' ').trim(),
    authority: String(raw.contractingAuthority || '').trim(),
    cpvFull: raw.cpvCode || '',
    publishedAt: raw.publicationDate,
    deadline: raw.tenderReceiptDeadline,
    valueRON: raw.estimatedValue || raw.maxEstimatedValue || raw.minEstimatedValue || 0,
    contractType: raw.sysAcquisitionContractType || '',
    noticeType: raw.sysAdvertisingNotice || ''
  };
}

/**
 * Curăță baza: duplicate și anunțuri expirate de mult (> RETENTION_DAYS),
 * păstrând anunțurile la care utilizatorul a lucrat.
 */
function cleanupList(list, now = new Date()) {
  const seen = new Set();
  const kept = [];
  let removed = 0;
  const cutoff = now.getTime() - RETENTION_DAYS * 86400000;
  for (const n of list) {
    const userTouched = n && (KEEP_STATUSES.has(n.status) || (n.notes && n.notes.trim()));
    const ref = n && new Date(n.deadline || n.publishedAt || 0).getTime();
    const tooOld = ref && ref < cutoff;
    if (!n || !n.code || seen.has(n.code) || (!userTouched && tooOld)) {
      removed++;
      continue;
    }
    seen.add(n.code);
    kept.push(n);
  }
  return { list: kept, removed };
}

// ============================================================================
//  Detalii anunț (condiții de participare, criterii, contact) + caiet de sarcini
// ============================================================================
const ADV_VIEW_API = id => `https://www.e-licitatie.ro/api-pub/PUBLICAdvNotice/getForView/${id}`;
const DETAILS_MAX_AGE_MS = 12 * 3600000;
const DETAILS_CONCURRENCY = 4;

function cleanText(v) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

async function getJSONWithCookies(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { ...SEAP_HEADERS, Referer: referer },
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    return { data: JSON.parse(text), cookie };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mapDetails(d) {
  const a = d.noticeEntityAddress || {};
  return {
    fetchedAt: new Date().toISOString(),
    contractDescription: cleanText(d.contractDescription),
    participationConditions: cleanText(d.participationConditions),
    awardCriteria: cleanText(d.awardCriteria),
    contractRelatedConditions: cleanText(d.contractRelatedConditions),
    additionalInformation: cleanText(d.additionalInformation),
    documentName: cleanText(d.documentName) || null,
    hasDocument: Boolean(d.documentUrl),
    county: cleanText(a.county && a.county.text) || null,
    city: cleanText(a.city) || null,
    address: cleanText(a.address) || null,
    email: cleanText(a.email) || null,
    phone: cleanText(a.phone) || null,
    contactPerson: cleanText(a.contactPerson || a.contactPoints) || null,
    website: cleanText(a.caMainAddressUrl) || null
  };
}

/** Descarcă detaliile unui anunț din SEAP (fără a le salva). */
async function fetchNoticeDetailsRaw(advNoticeId) {
  const { data, cookie } = await getJSONWithCookies(ADV_VIEW_API(advNoticeId), SEAP_ADV_VIEW_URL(advNoticeId));
  if (!data || !data.noticeNo) throw new Error('Anunțul nu a fost găsit în SEAP');
  return { raw: data, cookie };
}

/**
 * Întoarce detaliile anunțului (din cache dacă sunt recente, altfel din SEAP) și le salvează în baza locală.
 */
async function getNoticeDetails(code, { force = false } = {}) {
  const list = getNotices();
  const n = list.find(x => x.code === code);
  if (!n) throw new Error('Anunțul nu există în baza locală');
  if (!n.advNoticeId) throw new Error('Anunțul nu are ID SEAP (a fost adăugat manual)');
  const fresh = n.details && Date.now() - new Date(n.details.fetchedAt).getTime() < DETAILS_MAX_AGE_MS;
  if (fresh && !force) return n.details;

  const { raw } = await fetchNoticeDetailsRaw(n.advNoticeId);
  const details = mapDetails(raw);
  // re-citim lista (între timp poate a rulat o sincronizare) și salvăm doar câmpul nostru
  const latest = getNotices();
  const target = latest.find(x => x.code === code);
  if (target) {
    target.details = { ...(target.details || {}), ...details };
    if (details.county) target.county = details.county;
    saveNotices(latest);
  }
  return details;
}

/**
 * Completează detaliile pentru anunțurile IT în desfășurare care nu le au (sau sunt vechi).
 * Rulează după sincronizare, cu câteva cereri în paralel.
 */
async function enrichActiveITDetails(logs = []) {
  const now = new Date();
  const list = getNotices();
  const todo = list.filter(n => {
    if (!n.advNoticeId) return false;
    if (n.deadline && new Date(n.deadline) < now) return false;
    const cat = (n.manual && n.category) || detectCategory(n.title, n.cpvFull);
    if (!IT_CATEGORIES.has(cat)) return false;
    return !n.details || now - new Date(n.details.fetchedAt) > DETAILS_MAX_AGE_MS;
  });
  if (!todo.length) return 0;

  const results = new Map();
  let idx = 0;
  let failed = 0;
  async function worker() {
    while (idx < todo.length) {
      const n = todo[idx++];
      try {
        const { raw } = await fetchNoticeDetailsRaw(n.advNoticeId);
        results.set(n.code, mapDetails(raw));
      } catch (e) {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: DETAILS_CONCURRENCY }, worker));

  const latest = getNotices();
  for (const n of latest) {
    const d = results.get(n.code);
    if (!d) continue;
    n.details = { ...(n.details || {}), ...d }; // păstrăm câmpurile documentului descărcat (docFile...)
    if (d.county) n.county = d.county;
  }
  saveNotices(latest);
  logs.push(`📋 Detalii (condiții, caiet de sarcini) aduse pentru ${results.size} anunțuri IT în desfășurare${failed ? ` (${failed} eșuate)` : ''}`);
  return results.size;
}

// ---------------------------------------------------------------------------
//  Extragerea fișierului dintr-un document semnat .p7s (PKCS#7 / CMS SignedData, BER)
// ---------------------------------------------------------------------------
function readTLV(buf, pos) {
  const tag = buf[pos];
  let p = pos + 1;
  if ((tag & 0x1f) === 0x1f) { while (buf[p] & 0x80) p++; p++; } // tag pe mai mulți octeți
  let len = buf[p++];
  let indefinite = false;
  if (len === 0x80) { indefinite = true; len = -1; }
  else if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  return { tag, constructed: Boolean(tag & 0x20), headerEnd: p, len, indefinite };
}

/** Întoarce copiii unui element construit: [{tag, start, tlv}] și poziția de sfârșit. */
function readChildren(buf, tlv) {
  const children = [];
  let p = tlv.headerEnd;
  const end = tlv.indefinite ? buf.length : tlv.headerEnd + tlv.len;
  while (p < end) {
    if (tlv.indefinite && buf[p] === 0 && buf[p + 1] === 0) { p += 2; break; } // end-of-contents
    const c = readTLV(buf, p);
    const cEnd = c.indefinite ? skipIndefinite(buf, c) : c.headerEnd + c.len;
    children.push({ ...c, start: p, end: cEnd });
    p = cEnd;
  }
  return { children, end: p };
}

function skipIndefinite(buf, tlv) {
  return readChildren(buf, tlv).end;
}

/** Concatenează conținutul unui OCTET STRING (simplu sau fragmentat). */
function octetStringContent(buf, el) {
  if (!el.constructed) return buf.subarray(el.headerEnd, el.headerEnd + el.len);
  return Buffer.concat(readChildren(buf, el).children.map(c => octetStringContent(buf, c)));
}

function extractFromP7s(buf) {
  try {
    const root = readTLV(buf, 0);                                   // ContentInfo SEQUENCE
    const [, explicit0] = readChildren(buf, root).children;          // OID, [0]
    const [signedData] = readChildren(buf, explicit0).children;      // SignedData SEQUENCE
    const sdKids = readChildren(buf, signedData).children;           // version, digestAlgs, encapContentInfo, ...
    const encap = sdKids[2];
    const [, eContent0] = readChildren(buf, encap).children;         // eContentType, [0]
    if (!eContent0) return null;
    const [octets] = readChildren(buf, eContent0).children;
    const out = octetStringContent(buf, octets);
    return out.length ? out : null;
  } catch (e) {
    return null;
  }
}

function sniffType(buf, name = '') {
  const head = buf.subarray(0, 8).toString('latin1');
  const lower = name.toLowerCase();
  if (head.startsWith('%PDF')) return { ext: '.pdf', type: 'application/pdf', inline: true };
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    if (/\.docx/.test(lower)) return { ext: '.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false };
    if (/\.xlsx/.test(lower)) return { ext: '.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false };
    return { ext: '.zip', type: 'application/zip', inline: false };
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return { ext: /\.xls/.test(lower) ? '.xls' : '.doc', type: 'application/msword', inline: false };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: '.jpg', type: 'image/jpeg', inline: true };
  if (buf[0] === 0x89 && head.slice(1, 4) === 'PNG') return { ext: '.png', type: 'image/png', inline: true };
  return { ext: '', type: 'application/octet-stream', inline: false };
}

/**
 * Descarcă caietul de sarcini / documentația atașată anunțului.
 * Linkul SEAP e valabil doar în sesiunea în care s-a cerut anunțul, deci cerem întâi detaliile (cu cookie) și apoi fișierul.
 * @param {string} code
 * @param {{original?: boolean}} opts - original=true întoarce fișierul exact cum e în SEAP (ex. .p7s semnat)
 */
async function downloadNoticeDocument(code, { original = false } = {}) {
  const n = getNotices().find(x => x.code === code);
  if (!n || !n.advNoticeId) throw new Error('Anunțul nu are ID SEAP');
  const { raw, cookie } = await fetchNoticeDetailsRaw(n.advNoticeId);
  if (!raw.documentUrl) throw new Error('Anunțul nu are document atașat în SEAP');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let buf;
  try {
    const res = await fetch(`https://www.e-licitatie.ro/${String(raw.documentUrl).replace(/^\//, '')}`, {
      headers: { 'User-Agent': SEAP_HEADERS['User-Agent'], Referer: SEAP_ADV_VIEW_URL(n.advNoticeId), Cookie: cookie },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`SEAP a refuzat descărcarea (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const originalName = cleanText(raw.documentName) || `${code}-document`;
  if (original) return { buffer: buf, fileName: originalName, contentType: 'application/octet-stream', inline: false };

  let fileBuf = buf;
  let baseName = originalName;
  if (/\.p7s$|\.p7m$/i.test(originalName) || buf[0] === 0x30) {
    const inner = extractFromP7s(buf);
    if (inner) {
      fileBuf = inner;
      baseName = originalName.replace(/\.(p7s|p7m)$/i, '');
    }
  }
  const t = sniffType(fileBuf, baseName);
  if (t.ext && !baseName.toLowerCase().endsWith(t.ext)) baseName += t.ext;
  return { buffer: fileBuf, fileName: baseName, contentType: t.type, inline: t.inline };
}

let syncInProgress = null;
let syncProgress = null;

/**
 * Sincronizare cu SEAP: descarcă toate anunțurile din ultimele `days` zile, le clasifică (IT / non-IT)
 * și le îmbină cu baza locală (păstrând statusurile / notițele).
 * @param {{days?: number}} options
 */
function syncWithLiveSEAP(options = {}) {
  if (syncInProgress) return syncInProgress; // nu pornim două sincronizări simultan
  syncInProgress = (async () => {
    const days = Math.max(1, Math.min(90, Number(options.days) || 30));
    const logs = [];
    const startedAt = new Date();
    let liveReachable = false;
    let addedCount = 0;
    let updatedCount = 0;
    let itCount = 0;
    let itActiveCount = 0;
    let fetchedCount = 0;
    let error = null;
    syncProgress = { done: 0, total: days, fetched: 0 };

    let list = getNotices();
    const byCode = new Map(list.map(n => [n.code, n]));

    try {
      const raws = await fetchAdvNotices(days, logs, p => { syncProgress = p; });
      liveReachable = true;
      fetchedCount = raws.length;
      const now = new Date();

      for (const raw of raws) {
        const fresh = rawToNotice(raw);
        if (!fresh.code || !fresh.title) continue;
        fresh.category = detectCategory(fresh.title, fresh.cpvFull) || 'other';
        if (IT_CATEGORIES.has(fresh.category)) {
          itCount++;
          if ((!fresh.deadline || new Date(fresh.deadline) >= now) && !isCancelledTitle(fresh.title)) itActiveCount++;
        }
        const existing = byCode.get(fresh.code);
        if (existing) {
          // actualizăm datele din SEAP, dar păstrăm ce a setat utilizatorul
          Object.assign(existing, fresh, { manual: false });
          updatedCount++;
        } else {
          fresh.status = 'new';
          fresh.firstSeenAt = new Date().toISOString();
          list.push(fresh);
          byCode.set(fresh.code, fresh);
          addedCount++;
        }
      }
    } catch (err) {
      error = err.message;
      logs.push(`❌ Eroare SEAP: ${err.message}`);
    }

    const cleaned = cleanupList(list);
    list = cleaned.list;
    saveNotices(list);

    // detaliile (condiții de participare, caiet de sarcini) pentru anunțurile IT active
    let detailsCount = 0;
    if (!error) {
      try {
        syncProgress = { ...(syncProgress || {}), phase: 'details' };
        detailsCount = await enrichActiveITDetails(logs);
      } catch (e) {
        logs.push(`⚠️ Detalii anunțuri: ${e.message}`);
      }
    }

    const result = {
      success: !error,
      liveReachable,
      error,
      days,
      fetchedCount,
      itCount,
      itActiveCount,
      relevantCount: itActiveCount,
      addedCount,
      updatedCount,
      removedCount: cleaned.removed,
      totalCount: list.length,
      detailsCount,
      durationMs: Date.now() - startedAt.getTime(),
      logs,
      timestamp: new Date().toISOString()
    };

    const state = getSyncState();
    state.lastResult = { ...result, logs: undefined };
    if (!error) {
      state.lastSyncAt = result.timestamp;
      if (days >= 7) state.lastFullSyncAt = result.timestamp;
    }
    saveSyncState(state);
    return result;
  })().finally(() => {
    syncInProgress = null;
    syncProgress = null;
  });
  return syncInProgress;
}

function isSyncRunning() {
  return Boolean(syncInProgress);
}

function getSyncProgress() {
  return syncProgress;
}

module.exports = {
  getNotices,
  saveNotices,
  getOpportunities,
  filterNotices,
  findOpportunity,
  updateNoticeUserFields,
  addNotices,
  getCompanyProfile,
  saveCompanyProfile,
  getSyncState,
  syncWithLiveSEAP,
  isSyncRunning,
  getSyncProgress,
  getNoticeDetails,
  enrichActiveITDetails,
  downloadNoticeDocument,
  extractFromP7s,
  cleanupList,
  generateOfferPackage,
  classifyOpportunity,
  detectCategory,
  isCancelledTitle,
  buildOpportunity,
  normalizeText,
  CATEGORY_META,
  IT_CATEGORIES
};
