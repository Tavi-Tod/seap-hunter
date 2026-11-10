/*
 * SEAP Hunter — logica comună (clasificare IT, filtrare, oferte).
 * Folosită atât de serverul Node (seap-client.js), cât și direct în browser (versiunea GitHub Pages).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeapCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const EUR_RATE = 4.975;
const SEAP_PUBLIC_ADV_PAGE = 'https://www.e-licitatie.ro/pub/adv-notices/list/1';
const SEAP_ADV_VIEW_URL = id => `https://www.e-licitatie.ro/pub/notices/adv-notices/view/${id}`;

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
function filterList(list, f = {}) {
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

  for (const n of list) {
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

function generateOfferPackage(opp, profile) {
  const company = profile || {};
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


return {
  EUR_RATE,
  SEAP_PUBLIC_ADV_PAGE,
  SEAP_ADV_VIEW_URL,
  CATEGORY_META,
  IT_CATEGORIES,
  normalizeText,
  detectCategory,
  isCancelledTitle,
  classifyOpportunity,
  formatRO,
  buildOpportunity,
  parseDateParam,
  filterList,
  generateOfferPackage
};
});
