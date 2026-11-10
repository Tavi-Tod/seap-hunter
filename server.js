const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  filterNotices,
  findOpportunity,
  updateNoticeUserFields,
  addNotices,
  getNotices,
  getCompanyProfile,
  saveCompanyProfile,
  getSyncState,
  syncWithLiveSEAP,
  isSyncRunning,
  getSyncProgress,
  generateOfferPackage,
  detectCategory,
  getNoticeDetails,
  downloadNoticeDocument
} = require('./seap-client');
const { syncMarket, readMarket } = require('./market');

const PORT = process.env.PORT || 3080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Sincronizare automată cu e-licitatie.ro
const AUTO_SYNC_MINUTES = Number(process.env.AUTO_SYNC_MINUTES) || 30; // cât de des verificăm anunțuri noi
const FULL_SYNC_DAYS = Number(process.env.FULL_SYNC_DAYS) || 30;       // anunțurile ADV pot sta deschise ~4 săptămâni
const INCREMENTAL_SYNC_DAYS = 2;                                       // la verificările periodice
let nextAutoSyncAt = null;

async function runAutoSync(days, reason) {
  if (isSyncRunning()) return;
  console.log(`🔄 [${new Date().toLocaleTimeString('ro-RO')}] Sincronizare SEAP (${reason}, ultimele ${days} zile)...`);
  try {
    const r = await syncWithLiveSEAP({ days });
    if (r.success) {
      console.log(`   ✅ ${r.fetchedCount} anunțuri descărcate → ${r.itCount} IT (${r.itActiveCount} în desfășurare) | +${r.addedCount} noi | total în bază ${r.totalCount} (${Math.round(r.durationMs / 1000)}s)`);
    } else {
      console.log(`   ❌ ${r.error}`);
    }
  } catch (err) {
    console.log(`   ❌ Eroare sincronizare: ${err.message}`);
  }
}

function fullSyncDue() {
  const s = getSyncState();
  return !s.lastFullSyncAt || Date.now() - new Date(s.lastFullSyncAt).getTime() > 12 * 3600000 || getNotices().length === 0;
}

function startAutoSync() {
  // la pornire: sincronizare completă dacă nu s-a făcut în ultimele 12 ore, altfel doar incrementală
  runAutoSync(fullSyncDue() ? FULL_SYNC_DAYS : INCREMENTAL_SYNC_DAYS, 'pornire server');
  const marketSync = () => syncMarket({ ifOlderThanHours: 6, log: l => console.log('  ', l) }).catch(e => console.log(`   ⚠️ Piață: ${e.message}`));
  setTimeout(marketSync, 60000);            // după prima sincronizare
  setInterval(marketSync, 3 * 3600000);

  const intervalMs = AUTO_SYNC_MINUTES * 60000;
  nextAutoSyncAt = new Date(Date.now() + intervalMs);
  setInterval(() => {
    nextAutoSyncAt = new Date(Date.now() + intervalMs);
    runAutoSync(fullSyncDue() ? FULL_SYNC_DAYS : INCREMENTAL_SYNC_DAYS, 'automat');
  }, intervalMs);
}

function syncInfo() {
  return {
    ...getSyncState(),
    running: isSyncRunning(),
    progress: getSyncProgress(),
    nextAutoSyncAt,
    autoSyncMinutes: AUTO_SYNC_MINUTES,
    fullSyncDays: FULL_SYNC_DAYS
  };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 15 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
//  Parsare fișiere exportate din SEAP (CSV / XLSX)
// ---------------------------------------------------------------------------
function parseCSVLine(line) {
  const res = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      res.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  res.push(cur.trim());
  return res;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseXlsxBuffer(buffer) {
  const rows = [];
  let offset = 0;
  let sheetXml = '';
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name.includes('worksheets/sheet')) {
      const compData = buffer.slice(dataStart, dataStart + compSize);
      sheetXml = method === 0 ? compData.toString('utf8') : zlib.inflateRawSync(compData).toString('utf8');
      break;
    }
    offset = dataStart + compSize;
  }
  if (!sheetXml) return rows;

  const rowRegex = /<(?:x:)?row[^>]*>([\s\S]*?)<\/(?:x:)?row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const cols = [];
    const cellRegex = /<(?:x:)?v>([\s\S]*?)<\/(?:x:)?v>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cols.push(decodeXmlEntities(cellMatch[1]).trim());
    }
    if (cols.length > 0) rows.push(cols);
  }
  return rows;
}

// Parsează data din SEAP "DD.MM.YYYY HH:mm" (ex: "12.11.2026 14:00")
function parseSeapDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = Number(m[3]);
  const hour = Number(m[4] || 23);
  const min = Number(m[5] || 59);
  return new Date(year, month, day, hour, min, 0);
}

const FILTER_KEYS = ['scope', 'state', 'pubFrom', 'pubTo', 'dlFrom', 'dlTo', 'minValue', 'maxValue', 'q'];

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. GET /api/opportunities?scope=it|all|<categorie>&state=active|expired|all&pubFrom=YYYY-MM-DD&pubTo=...&dlFrom=...&dlTo=...&q=...
    if (req.method === 'GET' && (pathname === '/api/opportunities' || pathname === '/api/notices')) {
      const filters = {};
      for (const k of FILTER_KEYS) {
        const v = parsedUrl.searchParams.get(k);
        if (v !== null && v !== '') filters[k] = v;
      }
      const { opportunities, counts } = filterNotices(filters);
      return sendJSON(res, 200, {
        opportunities,
        counts,
        filters,
        totalInDatabase: getNotices().length,
        profile: getCompanyProfile(),
        sync: syncInfo()
      });
    }

    // 2. POST /api/sync (Scan Live SEAP e-licitatie.ro → Publicitate Anunțuri)
    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await parseBody(req);
      const result = await syncWithLiveSEAP({ days: Number(body.days) || FULL_SYNC_DAYS });
      return sendJSON(res, 200, result);
    }

    // 2a. GET /api/market → cumpărări directe atribuite (site-uri / web / găzduire)
    if (req.method === 'GET' && pathname === '/api/market') {
      return sendJSON(res, 200, readMarket());
    }

    // 2b. GET /api/sync-status
    if (req.method === 'GET' && pathname === '/api/sync-status') {
      return sendJSON(res, 200, { ...syncInfo(), totalCount: getNotices().length });
    }

    // 2c. GET /api/opportunities/:id/details  → condiții de participare, criterii, contact (din SEAP, cu cache)
    if (req.method === 'GET' && pathname.startsWith('/api/opportunities/') && pathname.endsWith('/details')) {
      const id = decodeURIComponent(pathname.split('/')[3]);
      try {
        const details = await getNoticeDetails(id, { force: parsedUrl.searchParams.get('refresh') === '1' });
        return sendJSON(res, 200, { details });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
    }

    // 2d. GET /api/opportunities/:id/document[?original=1]  → caietul de sarcini (PDF extras din .p7s semnat)
    if (req.method === 'GET' && pathname.startsWith('/api/opportunities/') && pathname.endsWith('/document')) {
      const id = decodeURIComponent(pathname.split('/')[3]);
      try {
        const doc = await downloadNoticeDocument(id, { original: parsedUrl.searchParams.get('original') === '1' });
        const asciiName = doc.fileName.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '');
        res.writeHead(200, {
          'Content-Type': doc.contentType,
          'Content-Length': doc.buffer.length,
          'Content-Disposition': `${doc.inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`
        });
        return res.end(doc.buffer);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>Nu s-a putut descărca documentul</h3><p>${String(err.message).replace(/</g, '&lt;')}</p><p>Încearcă butonul „Deschide în SEAP”.</p></body>`);
      }
    }

    // 3. PATCH /api/opportunities/:id/status
    if (req.method === 'PATCH' && pathname.startsWith('/api/opportunities/') && pathname.endsWith('/status')) {
      const id = decodeURIComponent(pathname.split('/')[3]);
      const body = await parseBody(req);
      const opportunity = updateNoticeUserFields(id, body);
      if (!opportunity) return sendJSON(res, 404, { error: 'Anunțul nu a fost găsit' });
      return sendJSON(res, 200, { opportunity });
    }

    // 4. GET /api/opportunities/:id/offer
    if (req.method === 'GET' && pathname.startsWith('/api/opportunities/') && pathname.endsWith('/offer')) {
      const id = decodeURIComponent(pathname.split('/')[3]);
      const opp = findOpportunity(id);
      if (!opp) return sendJSON(res, 404, { error: 'Anunțul nu a fost găsit' });
      const profile = getCompanyProfile();
      return sendJSON(res, 200, { offer: generateOfferPackage(opp, profile), opportunity: opp, profile });
    }

    // 5. POST /api/opportunities/custom (Adaugă anunț SEAP manual)
    if (req.method === 'POST' && pathname === '/api/opportunities/custom') {
      const body = await parseBody(req);
      const title = String(body.title || '').trim();
      if (!title) return sendJSON(res, 400, { error: 'Titlul este obligatoriu' });
      const code = String(body.code || `MANUAL-${Date.now()}`).trim();
      const cpvCode = String(body.cpvCode || '').trim();
      const authority = String(body.authority || 'Autoritate contractantă').trim();
      const notice = {
        code,
        advNoticeId: null,
        title,
        authority,
        county: String(body.county || '').trim() || undefined,
        cpvFull: cpvCode,
        publishedAt: new Date().toISOString(),
        deadline: body.deadline ? new Date(body.deadline).toISOString() : new Date(Date.now() + 3 * 86400000).toISOString(),
        valueRON: Number(body.estimatedValueRON) || 0,
        costRON: body.estimatedCostRON ? Number(body.estimatedCostRON) : undefined,
        contractType: '',
        noticeType: 'Adăugat manual',
        description: String(body.description || '').trim() || undefined,
        category: body.category || detectCategory(`${title} ${body.description || ''}`, cpvCode) || 'software_gestiune',
        status: 'new',
        manual: true
      };
      const added = addNotices([notice]);
      if (!added) return sendJSON(res, 409, { error: `Există deja un anunț cu codul ${code}` });
      return sendJSON(res, 201, { opportunity: findOpportunity(code) });
    }

    // 6. POST /api/import-csv (fișier .XLSX sau .CSV exportat din SEAP → Publicitate anunțuri)
    if (req.method === 'POST' && pathname === '/api/import-csv') {
      const body = await parseBody(req);
      const onlyActive = body.onlyActive !== false;
      const replaceExisting = body.replaceExisting === true;

      let parsedRows = [];
      if (body.xlsxBase64) parsedRows = parseXlsxBuffer(Buffer.from(body.xlsxBase64, 'base64'));
      else if (body.csvText) parsedRows = body.csvText.split(/\r?\n/).filter(l => l.trim()).map(parseCSVLine);

      if (parsedRows.length < 2) {
        return sendJSON(res, 400, { error: 'Fișierul XLSX / CSV este gol sau invalid.' });
      }

      const now = new Date();
      const notices = [];
      let skippedJunk = 0;
      let skippedExpired = 0;

      for (let i = 1; i < parsedRows.length; i++) {
        const cols = parsedRows[i];
        if (cols.length < 7) continue;
        // Coloane export SEAP: Autoritate, Nr. anunț, Denumire, Tip contract, Tip anunț, CPV, Data publicare, Termen, Valoare
        const [authority, code, title, contractType, noticeType, cpvFull = '', pubDate = '', deadlineDate = ''] = cols;
        const rawVal = String(cols[8] || '0').replace(/\s/g, '');
        const normalizedVal = rawVal.includes(',') && rawVal.includes('.')
          ? rawVal.replace(/\./g, '').replace(',', '.')
          : rawVal.replace(',', '.');
        const valRON = Math.round((parseFloat(normalizedVal) || 0) * 100) / 100;
        const dLimit = parseSeapDate(deadlineDate);

        if (onlyActive && dLimit && dLimit < now) {
          skippedExpired++;
          continue;
        }
        const category = detectCategory(title, cpvFull) || 'other';
        if (category === 'other') skippedJunk++;

        const pub = parseSeapDate(pubDate);
        notices.push({
          code,
          advNoticeId: null,
          title,
          authority,
          cpvFull,
          publishedAt: pub ? pub.toISOString() : null,
          deadline: dLimit ? dLimit.toISOString() : null,
          valueRON: valRON,
          contractType,
          noticeType: noticeType || 'Import fișier SEAP',
          category,
          status: 'new',
          manual: true
        });
      }

      const importedCount = addNotices(notices, { replaceManual: replaceExisting });
      return sendJSON(res, 200, { importedCount, skippedJunk, skippedExpired });
    }

    // 7. GET / PUT /api/profile
    if (req.method === 'GET' && pathname === '/api/profile') {
      return sendJSON(res, 200, { profile: getCompanyProfile() });
    }
    if (req.method === 'PUT' && pathname === '/api/profile') {
      const body = await parseBody(req);
      return sendJSON(res, 200, { profile: saveCompanyProfile(body) });
    }

    // Fișiere statice din /public
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  } catch (err) {
    console.error('Server error:', err);
    sendJSON(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Portul ${PORT} este deja folosit. Probabil serverul rulează deja — deschide http://localhost:${PORT}`);
    console.error(`   (sau pornește pe alt port: PORT=3081 npm start)\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================================`);
  console.log(` 🚀 SEAP Hunter (e-licitatie.ro → Publicitate anunțuri) rulează pe: http://localhost:${PORT}`);
  console.log(` 🎯 Categorii IT: Site-uri & portaluri • Software & servicii IT • Echipamente & rețele • Kituri Smart Lab`);
  console.log(` 🔄 Sincronizare automată: la pornire (${FULL_SYNC_DAYS} zile) + la fiecare ${AUTO_SYNC_MINUTES} min`);
  console.log(`======================================================================\n`);
  startAutoSync();
});
