const fs = require('fs');
const path = require('path');

// ============================================================================
//  Configurare
// ============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');          // TOATE anunțurile descărcate (IT + non-IT)
const LEGACY_DB_FILE = path.join(DATA_DIR, 'opportunities.json');  // format vechi (doar pentru migrare)
const PROFILE_FILE = path.join(DATA_DIR, 'company-profile.json');
const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

const EUR_RATE = 4.975;

// Endpoint-ul public SEAP pentru "Publicitate Anunțuri" (anunțuri ADV la care se poate oferta).
const ADV_LIST_URL = 'https://www.e-licitatie.ro/api-pub/AdvNoticeCommon/GetAdvNoticeList/';
const SEAP_PUBLIC_ADV_PAGE = 'https://www.e-licitatie.ro/pub/adv-notices/list/1';
const SEAP_ADV_VIEW_URL = id => `https://www.e-licitatie.ro/pub/notices/adv-notices/view/${id}`;
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

// ============================================================================
//  Clasificare IT (Site-uri / Software / Echipamente & Rețele / Kituri)
// ============================================================================
function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // scoate diacriticele (ă, â, î, ș, ş, ț, ţ)
    .toLowerCase();
}

const CATEGORY_META = {
  web_registratura: {
    categoryLabel: '🌐 Site-uri & Portaluri Web',
    margin: 0.97,
    executionTime: '1 - 2 după-amieze (Template UAT/Școală + Registratură)'
  },
  software_gestiune: {
    categoryLabel: '💻 Software, Aplicații & Servicii IT',
    margin: 0.96,
    executionTime: '3 - 4 zile (Aplicație Web + Bază de date + OCR)'
  },
  hardware_it: {
    categoryLabel: '🖥️ Echipamente & Rețele IT',
    margin: 0.15, // revânzare hardware: marjă realistă de distribuitor
    executionTime: '3 - 7 zile (comandă distribuitor + livrare)'
  },
  smart_lab_kits: {
    categoryLabel: '🤖 Kituri Smart Lab / Robotică',
    margin: 0.87,
    executionTime: '2 - 3 zile (Asamblare kituri + Ghid PDF RO)'
  },
  other: {
    categoryLabel: '📋 Alte domenii (non-IT)',
    margin: 0,
    executionTime: '-'
  }
};
const IT_CATEGORIES = new Set(['web_registratura', 'software_gestiune', 'hardware_it', 'smart_lab_kits']);

// CPV-uri IT (prefixe) → categorie. Prima regulă care se potrivește câștigă.
const CPV_RULES = [
  [/^7241[1-9]|^7242|^7252/, 'web_registratura'],                 // site-uri, găzduire, internet
  [/^4882/, 'hardware_it'],                                         // servere (clasa 48 dar e hardware)
  [/^48|^72/, 'software_gestiune'],                                 // software + servicii IT
  [/^302|^3014|^3019620|^30195200/, 'hardware_it'],                 // calculatoare, periferice, table interactive
  [/^3241|^3242|^3252|^3256|^32570|^3258/, 'hardware_it'],                // rețele / echipamente de rețea
  [/^5031[2-6]|^5032[0-4]|^5161[1-2]/, 'hardware_it'],              // reparații/mentenanță/instalare IT
  [/^79999100|^79999200|^79132100/, 'software_gestiune'],           // scanare/digitalizare, semnătură electronică
  [/^80533/, 'software_gestiune'],                                  // instruire IT
  [/^391621|^38970/, 'smart_lab_kits']                              // material didactic / simulatoare
];

// Au CPV IT, dar nu sunt "IT" în sensul nostru (consumabile, mobilier, automatizări porți...)
const CPV_JUNK_RE = /(toner|cartus|hartie|consumabil|unitati de imagine|cilindru|cerneala|mobilier|poart|sonorizare|airsoft|air soft|incendiu|alarmare|efractie)/;

const WEB_RE = /\b(site|site-ul|site-uri|siteului|website|pagin(a|ii|ilor) (de )?(web|internet)|portal(ul|uri)?( web| online| de servicii| informatic| institutional| e-?)|gazduire|hosting|nume de domeniu|domeniu(l)? (web|\.ro)|monitorul oficial local|registratur|magazin online|e-?commerce)/;
const SOFT_RE = /(software|\bsoft(ul|uri)?\b|aplicati|program(e|ul)? (informatic|de calculator|software)|licent(a|e|ei) (software|antivirus|microsoft|windows|office|program|de utilizare)|\blicent(a|e) .{0,40}(software|program|aplicati)|abonament.{0,30}(microsoft|office|365|adobe|software|cloud)|platform(a|e|ei) (digital|online|informatic|educa|web|e-?learning|software|de (videoconferint|elearning|e-learning|design))|e-?learning|arhiv(a|are|ei)? (electronic|digital)|digitaliz|baz(a|e) de date|sistem(ul|e)? informatic|informatic|mentenanta (aplicati|soft|it\b)|\bcloud\b|\berp\b|\bcrm\b|\bgis\b|securitat(e|ii) cibernetic|cyber ?security|antivirus|\bocr\b|inteligent(a|ei) artificial|chatbot|semnatur(a|i) electronic|certificat(e)? digital|dezvoltare (aplicati|software|platform)|\bsaas\b|subscripti(e|a) (software|licent|aplicati)|videoconferint)/;
const HW_RE = /(calculator(ul|ului|e|oare)?\b|computer|laptop|notebook|\bdesktop|\bpc(-uri)?\b|all-in-one|\bserver(e|ul)?\b|imprimant|multifunctional(a|e|ele)? (laser|a3|a4|monocrom|color|cu imprimant|de birou)|\bscanner|\bmonitor(ul|e|oare)?\b|monitoare|\btablet(a|e) (pc|android|grafic|educa)|\btablete\b|retea (it|informatic|de date|de calculatoare|lan|wireless|internet)|retelistica|cablare structurata|\blan\b|wi-?fi|wireless|\brouter(e)?\b|\bswitch|firewall|access point|\bups(-uri)?\b|echipament(e)? (it|informatic|de calcul|ict|tic|de retea|periferic)|tehnic(a|ii) de calcul|\bit&c\b|\bit\b|\bict\b|\btic\b|videoproiector|display interactiv|tabl(a|e) interactiv|ecran(e)? interactiv|hard ?disk|\bssd\b|stocare (date|de date|nas)|\bnas\b|network attached storage|periferic|tastatur|\bmouse\b|webcam|camer(a|e) web|patch ?cord|\butp\b|\brack\b)/;
const KITS_RE = /(robotic|arduino|esp32|raspberry|micro:?bit|smart ?lab|laborator (inteligent|de informatica|digital|stem)|kit(uri)? (educa|stem|didactic|robot)|\bstem\b|imprimant(a|e) 3d|printer 3d|drona educa)/;

// Cuvinte capcană: "site" = șantier, "portal" = poartă, "rețea" = apă/gaz, "multifuncțional" = spray etc.
const JUNK_RE = /(ferestre|tamplarie|tantari|vopsea|imprejmuire|grup electrogen|aer conditionat|climatizare|catering|spalatorie|stingere|cadastr|canalizare|paratrasnet|anvelope|combustibil|motorina|benzina|lemne|dezinfect|reactivi|medicament|toner|cartus|fotocopiat|plicuri|papetar|birotica|rechizite|curatenie|alimente|\bpaza\b|deszapezire|betonat|autoutilitar|camionet|autoturism|lucrari de constructi|santier|acoperis|mobilier|poarta|portal(ul)? (de )?acces|dedurizare|\bcnc\b|elicopter|airsoft|air soft|mese? calde|apa potabila|retea (de )?(apa|gaz|canal|termic|electric)|iluminat|sudur|tractor|asfalt|scaune|incendiu|lubrifiant|exercitii|tester|consumabil|tiparire|flyer|brosur|radar|alarmare|studii de piata)/;

/**
 * Întoarce categoria IT a anunțului sau null dacă NU e din zona IT.
 */
function detectCategory(title = '', cpvFull = '') {
  const cpv = String(cpvFull || '').trim();
  const t = normalizeText(title);

  for (const [re, cat] of CPV_RULES) {
    if (!re.test(cpv)) continue;
    if (CPV_JUNK_RE.test(t)) return null;
    if (cat === 'smart_lab_kits') {
      return KITS_RE.test(t) || /didactic|educa|laborator|scoal|elev|robot/.test(t) ? 'smart_lab_kits' : null;
    }
    if (cat !== 'web_registratura' && WEB_RE.test(t) && !JUNK_RE.test(t)) return 'web_registratura';
    return cat;
  }

  if (JUNK_RE.test(t)) return null;
  if (KITS_RE.test(t)) return 'smart_lab_kits';
  if (WEB_RE.test(t)) return 'web_registratura';
  if (SOFT_RE.test(t) || /\bAI\b/.test(String(title))) return 'software_gestiune';
  // servicii IT (audit, mentenanță, suport) fără CPV IT → le punem la servicii, nu la echipamente
  if (HW_RE.test(t)) return /\bservici/.test(t) && !/reparati|mentenanta (echipament|calculat|imprimant)/.test(t) ? 'software_gestiune' : 'hardware_it';
  return null;
}

function isCancelledTitle(title) {
  return /\banulat(a|e)?\b|\banulare(a)?\b/.test(normalizeText(title));
}

// Compatibilitate: folosit de adăugarea manuală
function classifyOpportunity(title = '', cpvCode = '', description = '') {
  const cat = detectCategory(`${title} ${description}`, cpvCode) || 'software_gestiune';
  return { category: cat, ...CATEGORY_META[cat] };
}

// ============================================================================
//  Construirea obiectului oportunitate (format folosit de interfață)
// ============================================================================
function formatRO(date) {
  if (!date || isNaN(date)) return '-';
  return date.toLocaleString('ro-RO', {
    timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Transformă un anunț compact (din notices.json) în obiectul complet afișat în interfață.
 * @param {object} n - { code, advNoticeId, title, authority, cpvFull, publishedAt, deadline, valueRON, contractType, noticeType, category, status, notes, costRON }
 */
function buildOpportunity(n, now = new Date()) {
  // categoria se recalculează la fiecare citire (îmbunătățirile clasificatorului se aplică și pe datele vechi);
  // pentru anunțurile adăugate manual păstrăm categoria aleasă
  const category = (n.manual && n.category) || detectCategory(n.title, n.cpvFull) || 'other';
  const meta = CATEGORY_META[category] || CATEGORY_META.other;
  const valRON = Math.round((Number(n.valueRON) || 0) * 100) / 100;
  const costRON = n.costRON != null ? Number(n.costRON) : Math.round(valRON * (1 - meta.margin));
  const profitRON = category === 'other' ? 0 : Math.max(0, Math.round(valRON - costRON));
  const cpvCode = String(n.cpvFull || '').split(' ')[0].trim();
  const pub = n.publishedAt ? new Date(n.publishedAt) : null;
  const dl = n.deadline ? new Date(n.deadline) : null;
  const authority = String(n.authority || '').trim();
  const cuiMatch = authority.match(/^(?:RO\s*)?(\d{2,10})\s+(.*)$/i);
  const lower = normalizeText(`${n.title} ${n.cpvFull}`);
  const cancelled = isCancelledTitle(n.title);
  const active = !cancelled && (!dl || dl >= now);

  return {
    id: n.code,
    code: n.code,
    advNoticeId: n.advNoticeId || null,
    source: n.manual ? 'manual' : 'seap-adv',
    type: `${n.noticeType || 'Anunț de publicitate'}${n.contractType ? ` • ${n.contractType}` : ''}`,
    title: n.title,
    category,
    categoryLabel: meta.categoryLabel,
    isIT: IT_CATEGORIES.has(category),
    isActive: active,
    isCancelled: cancelled,
    authority: cuiMatch ? cuiMatch[2] : authority,
    cui: cuiMatch ? cuiMatch[1] : '-',
    county: n.county || '-',
    city: '',
    cpvCode,
    cpvName: n.cpvFull || cpvCode,
    estimatedValueRON: valRON,
    estimatedValueEUR: Math.round(valRON / EUR_RATE),
    estimatedCostRON: costRON,
    estimatedProfitRON: profitRON,
    estimatedProfitEUR: Math.round(profitRON / EUR_RATE),
    profitMarginPercent: valRON > 0 ? Math.round((profitRON / valRON) * 100) : 0,
    executionTime: meta.executionTime,
    isPNRR: /pnrr|smis|roua\d|hub digital|\bced\b/.test(lower),
    fundingSource: `Publicat: ${formatRO(pub)} • Termen limită ofertă: ${formatRO(dl)}`,
    publishedAt: pub ? pub.toISOString() : null,
    deadline: dl ? dl.toISOString() : null,
    status: n.status || 'new',
    notes: n.notes || '',
    opportunityScore: category === 'other' ? 0 : category === 'hardware_it' ? 75 : (/^(72|48)/.test(cpvCode) ? 99 : 92),
    contactEmail: 'Vezi anunțul în SEAP',
    contactPhone: `Nr. anunț: ${n.code}`,
    description: n.description || `Anunț SEAP ${n.code}: "${n.title}". Autoritate: ${authority}. CPV: ${n.cpvFull}. Termen limită: ${formatRO(dl)}.`,
    requirements: [
      `Intră pe e-licitatie.ro → Publicitate anunțuri → caută Nr. anunț ${n.code}`,
      `Descarcă caietul de sarcini și trimite oferta până la ${formatRO(dl)}`,
      'Publică poziția în Catalogul Electronic SEAP cu același cod CPV'
    ],
    bomItems: [{ item: n.title, qty: 1, unitCostRON: costRON, unitPriceRON: valRON }],
    seapUrl: n.advNoticeId ? SEAP_ADV_VIEW_URL(n.advNoticeId) : SEAP_PUBLIC_ADV_PAGE,
    details: n.details || null,
    firstSeenAt: n.firstSeenAt || null
  };
}

// ============================================================================
//  Filtrare (folosită de API-ul local și de CLI)
// ============================================================================
function parseDateParam(v, endOfDay = false) {
  if (!v) return null;
  // acceptă "YYYY-MM-DD" (interpretat în ora locală) sau ISO complet
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0)
    : new Date(v);
  return isNaN(d) ? null : d;
}

/**
 * @param {object} f
 *   scope: 'it' (implicit) | 'all' | 'other' | o categorie anume (web_registratura, ...)
 *   state: 'active' (implicit, în desfășurare) | 'expired' | 'all'
 *   pubFrom, pubTo: interval dată publicare (YYYY-MM-DD)
 *   dlFrom, dlTo:   interval termen limită depunere oferte (YYYY-MM-DD)
 *   minValue, maxValue: valoare estimată RON
 *   q: text liber (titlu, autoritate, CPV, cod)
 */
function filterNotices(f = {}) {
  const now = new Date();
  const scope = f.scope || 'it';
  const state = f.state || 'active';
  const pubFrom = parseDateParam(f.pubFrom);
  const pubTo = parseDateParam(f.pubTo, true);
  const dlFrom = parseDateParam(f.dlFrom);
  const dlTo = parseDateParam(f.dlTo, true);
  const minValue = f.minValue !== undefined && f.minValue !== '' ? Number(f.minValue) : null;
  const maxValue = f.maxValue !== undefined && f.maxValue !== '' ? Number(f.maxValue) : null;
  const q = normalizeText(f.q || '').trim();

  const counts = { all: 0, it: 0, other: 0 };
  for (const c of Object.keys(CATEGORY_META)) counts[c] = 0;
  const results = [];

  for (const n of getNotices()) {
    const o = buildOpportunity(n, now);
    // filtrele de dată / stare / valoare / text se aplică înainte de numărătoarea pe categorii
    if (state === 'active' && !o.isActive) continue;
    if (state === 'expired' && o.isActive) continue;
    const pub = o.publishedAt ? new Date(o.publishedAt) : null;
    const dl = o.deadline ? new Date(o.deadline) : null;
    if (pubFrom && (!pub || pub < pubFrom)) continue;
    if (pubTo && (!pub || pub > pubTo)) continue;
    if (dlFrom && (!dl || dl < dlFrom)) continue;
    if (dlTo && (!dl || dl > dlTo)) continue;
    if (minValue !== null && o.estimatedValueRON < minValue) continue;
    if (maxValue !== null && o.estimatedValueRON > maxValue) continue;
    if (q && !normalizeText(`${o.code} ${o.title} ${o.authority} ${o.cui} ${o.cpvName}`).includes(q)) continue;

    counts.all++;
    counts[o.category] = (counts[o.category] || 0) + 1;
    if (o.isIT) counts.it++;

    if (scope === 'it' && !o.isIT) continue;
    if (scope !== 'it' && scope !== 'all' && o.category !== scope) continue;
    results.push(o);
  }

  results.sort((a, b) => new Date(a.deadline || 8.64e15) - new Date(b.deadline || 8.64e15));
  return { opportunities: results, counts };
}

/** Compatibilitate cu codul vechi: lista anunțurilor IT în desfășurare. */
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
    target.details = details;
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
    n.details = d;
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

function generateOfferPackage(opp, profile) {
  const company = profile || getCompanyProfile();
  const offeredRON = Math.round(opp.estimatedValueRON * 0.96);
  const offeredEUR = Math.round(offeredRON / EUR_RATE);
  const netProfitRON = offeredRON - opp.estimatedCostRON;

  const catalogTitle = `[${opp.code}] ${opp.title.slice(0, 110)}`;
  const emailSubject = `Ofertă Tehnică și Financiară - Anunț SEAP ${opp.code} - ${opp.title}`;

  const emailBody = `Către: ${opp.authority}
În atenția: Compartimentului Achiziții Publice / Comisiei de Evaluare PNRR
Referință: Anunț de Publicitate SEAP nr. ${opp.code} ("${opp.title}")
Cod CPV: ${opp.cpvCode} (${opp.cpvName})

Stimată Doamnă / Stimate Domn,

Subscrisa ${company.companyName}, având CUI ${company.cui}, Nr. Reg. Com. ${company.regCom} și cont de Trezorerie ${company.ibanTreasury}, vă transmitem alăturat Oferta Tehnică și Financiară pentru achiziția directă "${opp.title}" (Anunț SEAP ${opp.code}).

✅ SINTEZA OFERTEI NOASTRE:
• Valoare totală ofertată: ${offeredRON.toLocaleString('ro-RO')} RON (fără TVA) — încadrată sub pragul bugetar estimat de ${opp.estimatedValueRON.toLocaleString('ro-RO')} RON;
• Conformitate Tehnică: 100% conform cerințelor din Caietul de Sarcini și ghidului de finanțare (${opp.fundingSource});
• Termen de livrare / implementare: ${opp.executionTime.split('(')[0].trim()} (mult sub termenul maxim solicitat);
• Disponibilitate imediată în Catalogul Electronic SEAP (e-licitatie.ro) sub denumirea:
  "${catalogTitle}" (Cod CPV: ${opp.cpvCode}).

Putem publica poziția în Catalogul Electronic SEAP imediat sau o puteți regăsi direct după codul ${opp.code} / CUI ${company.cui}. Facturarea se realizează prin sistemul național RO e-Factura, cu plata în contul nostru de Trezorerie.

Pentru orice clarificări sau o scurtă demonstrație tehnică (10 minute), vă stăm la dispoziție la numărul ${company.phone} sau prin reply la acest e-mail.

Cu deosebită considerație,
${company.representative}
${company.companyName}
Tel: ${company.phone} | Email: ${company.email}`;

  const requirementsListText = (opp.requirements || [])
    .map((req, idx) => `   ${idx + 1}. [CONFORM 100%] ${req}`)
    .join('\n');

  const bomTableText = (opp.bomItems || [])
    .map((b, idx) => {
      const lineTotal = Math.round(b.qty * b.unitPriceRON * 0.96);
      const unitOffer = Math.round(b.unitPriceRON * 0.96);
      return `   ${idx + 1}. ${b.item}\n      Cantitate: ${b.qty} buc/lic | Preț unitar: ${unitOffer.toLocaleString('ro-RO')} RON | Total: ${lineTotal.toLocaleString('ro-RO')} RON`;
    })
    .join('\n');

  const technicalProposal = `================================================================================
                     PROPUNERE TEHNICĂ ȘI FINANCIARĂ
          ACHIZIȚIE DIRECTĂ SEAP: ${opp.code} | COD CPV: ${opp.cpvCode}
================================================================================

1. DATELE AUTORITĂȚII CONTRACTANTE:
   • Instituție: ${opp.authority} (CUI: ${opp.cui})
   • Județ / Localitate: ${opp.county} ${opp.city ? `/ ${opp.city}` : ''}
   • Sursă de finanțare: ${opp.fundingSource}

2. DATELE OFERTANTULUI:
   • Operator Economic: ${company.companyName}
   • CUI / CIF: ${company.cui} | Reg. Com.: ${company.regCom}
   • Cont Trezorerie: ${company.ibanTreasury}
   • Reprezentant & Contact: ${company.representative} (${company.phone} / ${company.email})

3. MATRICEA DE CONFORMITATE TEHNICĂ (CAIET DE SARCINI):
${requirementsListText}

4. DEVIZ FINANCIAR DETALIAT (OFERTĂ FERMĂ):
${bomTableText}

   -----------------------------------------------------------------------------
   VALOARE TOTALĂ ESTIMATĂ AUTORITATE:   ${opp.estimatedValueRON.toLocaleString('ro-RO')} RON
   VALOARE TOTALĂ OFERTATĂ (FERMĂ):      ${offeredRON.toLocaleString('ro-RO')} RON (~${offeredEUR.toLocaleString('ro-RO')} EUR)
   ECONOMIE BUGETARĂ PENTRU INSTITUȚIE:  ${(opp.estimatedValueRON - offeredRON).toLocaleString('ro-RO')} RON (4%)
   -----------------------------------------------------------------------------

5. GARANȚIE, SUPORT ȘI MENTENANȚĂ:
   • Garanție tehnică și actualizări: 24 luni incluse în preț, fără costuri ascunse;
   • Sesiune de instruire (training) cu personalul desemnat + Manual complet în limba română (PDF);
   • Predare pe bază de Proces-Verbal de Recepție și facturare în RO e-Factura.`;

  return {
    opportunityId: opp.id,
    code: opp.code,
    offeredRON,
    offeredEUR,
    estimatedCostRON: opp.estimatedCostRON,
    netProfitRON,
    netProfitEUR: Math.round(netProfitRON / EUR_RATE),
    catalogTitle,
    cpvCode: opp.cpvCode,
    emailSubject,
    emailBody,
    technicalProposal
  };
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
