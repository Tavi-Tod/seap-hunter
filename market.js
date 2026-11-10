/**
 * Piață: cumpărări directe DEJA ATRIBUITE din SEAP pentru site-uri / web / găzduire.
 * Arată cine cumpără, de la cine și la ce preț — și ce instituții sunt clienți potențiali.
 *
 * Sursa: API-ul public e-licitatie.ro → Cumpărări directe (GetDirectAcquisitionList),
 * filtrat după denumire (câmpul directAcquisitionName) și data finalizării.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SEAP_DATA_DIR ? path.resolve(process.env.SEAP_DATA_DIR) : path.join(__dirname, 'data');
const MARKET_FILE = path.join(DATA_DIR, 'market.json');
const DA_LIST_URL = 'https://www.e-licitatie.ro/api-pub/DirectAcquisitionCommon/GetDirectAcquisitionList/';
const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json;charset=UTF-8',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://www.e-licitatie.ro',
  'Referer': 'https://www.e-licitatie.ro/pub/direct-acquisitions/list/1'
};
const KEYWORDS = ['site', 'web', 'gazduire', 'găzduire', 'hosting', 'nume de domeniu'];
const KEEP_RE = /(\bsite(-ul|-uri|-urilor|ul|uri|ului)?\b|website|pagin(a|ii) (de )?(web|internet)|portal (web|online|institutional)|gazduire|găzduire|hosting|nume (de )?domeniu|domeniu (web|\.ro|de internet))/i;
const JUNK_RE = /(portal (de )?(acces|intrare)|poarta|santier|şantier|web ?cam|camera web|webcam|cablu|toner|publicitate|anunt|anunț|promovare|presa|presă|radio|tv\b|televiziune|ziar|abonament (ziar|presa)|monitorul oficial al romaniei|monitorul oficial al româniei|tichete|bilete|cazare|transport|deseuri|deșeuri|vopsea|fotovoltaic|sitem)/i;
// CPV-uri de publicitate / presă / evenimente — nu sunt servicii web
const JUNK_CPV_RE = /^(7934|7982|7995|2221|2220|6411|5511|6010|9221|9222)/;
const MONTHS_FULL = 12;
const MAX_PER_QUERY = 2000;
const PAGE_SIZE = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(body, attempt = 1) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const res = await fetch(DA_LIST_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 3) { await sleep(1500 * attempt); return post(body, attempt + 1); }
    throw e;
  }
}

/** Toate rezultatele pentru un cuvânt într-un interval; împarte intervalul dacă SEAP trunchiază la 2000. */
async function fetchRange(word, start, end, out) {
  const base = { pageSize: PAGE_SIZE, showOngoingDa: false, cookieContext: null, directAcquisitionName: word,
    finalizationDateStart: start.toISOString(), finalizationDateEnd: end.toISOString() };
  const first = await post({ ...base, pageIndex: 0 });
  if ((first.total || 0) >= MAX_PER_QUERY && end - start > 86400000) {
    const mid = new Date(start.getTime() + Math.floor((end - start) / 2));
    await fetchRange(word, start, mid, out);
    await fetchRange(word, new Date(mid.getTime() + 1), end, out);
    return;
  }
  const pages = Math.ceil(Math.min(first.total || 0, MAX_PER_QUERY) / PAGE_SIZE);
  (first.items || []).forEach(x => out.set(x.uniqueIdentificationCode, x));
  for (let p = 1; p < pages; p++) {
    const j = await post({ ...base, pageIndex: p });
    (j.items || []).forEach(x => out.set(x.uniqueIdentificationCode, x));
  }
}

function isRelevant(name, cpv) {
  const n = String(name || '');
  return KEEP_RE.test(n) && !JUNK_RE.test(n) && !JUNK_CPV_RE.test(String(cpv || ''));
}

function splitCode(s) {
  const m = String(s || '').trim().match(/^(?:RO\s*)?(\d{2,10})\s+(.*)$/i);
  return m ? { cui: m[1], name: m[2].trim() } : { cui: '', name: String(s || '').trim() };
}

function classifyType(name) {
  const t = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/(realiz|creare|proiectare|dezvolt|desing|design|construire|redesign|refacere|implementare|site nou|elaborare|configurare site)/.test(t)) return 'nou';
  if (/(mentenan|mentenat|actualiz|administrare|intretinere|suport|asistenta|service)/.test(t)) return 'mentenanta';
  if (/(gazduire|hosting|domeniu|nume de domeniu)/.test(t)) return 'gazduire';
  return 'altele';
}

function classifyBuyer(name) {
  const t = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/(scoal|liceu|colegiu|gradinit|gimnaz|scolar|palatul copiilor|clubul copiilor|seminar teologic|centrul scolar)/.test(t)) return 'scoala';
  if (/(primari|comuna|\boras|municipi|consiliul (local|judetean)|\buat\b)/.test(t)) return 'primarie';
  return 'alta';
}

function toLean(x) {
  const sup = splitCode(x.supplier);
  const ca = splitCode(x.contractingAuthority);
  // format compact (chei scurte) — fișierul ajunge pe telefon
  return {
    c: x.uniqueIdentificationCode,
    i: x.directAcquisitionId,
    n: String(x.directAcquisitionName || '').replace(/\s+/g, ' ').trim(),
    p: String(x.cpvCode || '').split(' ')[0],
    d: String(x.finalizationDate || x.publicationDate || '').slice(0, 10),
    v: Math.round(Number(x.closingValue || x.estimatedValueRon || 0)),
    s: sup.name, sc: sup.cui,
    b: ca.name, bc: ca.cui,
    t: classifyType(x.directAcquisitionName),
    bt: classifyBuyer(x.contractingAuthority)
  };
}

function readMarket() {
  try { return JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); } catch (e) { return { syncedAt: null, fullSyncedAt: null, items: [] }; }
}

function writeMarket(m) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MARKET_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, MARKET_FILE);
}

let running = null;

/**
 * Actualizează datele de piață. Complet (12 luni) o dată pe zi, altfel doar ultimele 2 luni.
 * @param {{force?: boolean, months?: number, log?: Function}} opts
 */
function syncMarket(opts = {}) {
  if (running) return running;
  running = (async () => {
    const log = opts.log || (() => {});
    const m = readMarket();
    // nu reîmprospătăm mai des de X ore (ex. butonul rapid „Actualizează acum”)
    if (opts.ifOlderThanHours && m.syncedAt && Date.now() - new Date(m.syncedAt).getTime() < opts.ifOlderThanHours * 3600000) {
      return { skipped: true, count: (m.items || []).length };
    }
    const fullDue = !m.fullSyncedAt || Date.now() - new Date(m.fullSyncedAt).getTime() > 24 * 3600000;
    const months = opts.months || (fullDue || opts.force ? MONTHS_FULL : 2);
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - months);
    start.setHours(0, 0, 0, 0);

    const raw = new Map();
    for (const w of KEYWORDS) await fetchRange(w, start, end, raw);

    const fresh = [...raw.values()]
      .filter(x => isRelevant(x.directAcquisitionName, x.cpvCode))
      .map(toLean);

    const byCode = new Map((m.items || []).filter(x => x.c).map(x => [x.c, x]));
    for (const x of fresh) byCode.set(x.c, x);
    // păstrăm ultimele ~13 luni
    const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const items = [...byCode.values()].filter(x => (x.d || '') >= cutoff && isRelevant(x.n, x.p))
      .map(x => ({ ...x, t: classifyType(x.n), bt: classifyBuyer(x.b) })); // reclasificăm și datele vechi

    const now = new Date().toISOString();
    const out = { syncedAt: now, fullSyncedAt: months >= MONTHS_FULL ? now : m.fullSyncedAt, months, items };
    writeMarket(out);
    log(`📊 Piață: ${fresh.length} cumpărări directe web în ultimele ${months} luni (total ${items.length} în bază)`);
    return { count: items.length, fetched: fresh.length, months };
  })().finally(() => { running = null; });
  return running;
}

module.exports = { syncMarket, readMarket, classifyType, classifyBuyer, MARKET_FILE };
