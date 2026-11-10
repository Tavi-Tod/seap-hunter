#!/usr/bin/env node
/**
 * Construiește versiunea statică (GitHub Pages) a SEAP Hunter.
 *
 * Rulează în GitHub Actions:
 *   1. sincronizează anunțurile din SEAP (în SEAP_DATA_DIR, păstrat pe ramura "data")
 *   2. descarcă și extrage caietele de sarcini pentru anunțurile IT în desfășurare
 *   3. scrie site-ul în ./site (pagina + data/notices.json + docs/*)
 *
 * Variabile de mediu:
 *   SEAP_DATA_DIR  – folderul cu baza de date (implicit ./data)
 *   SYNC_DAYS      – forțează numărul de zile (altfel: 30 dacă ultima sincronizare completă e mai veche de 12h, altfel 2)
 *   SITE_DIR       – unde se scrie site-ul (implicit ./site)
 *   GITHUB_REPOSITORY – owner/repo (setat automat de GitHub Actions)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.SEAP_DATA_DIR = process.env.SEAP_DATA_DIR || path.join(ROOT, 'data');
const DATA_DIR = path.resolve(process.env.SEAP_DATA_DIR);
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(ROOT, 'site'));
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const KEEP_DAYS_ON_SITE = 45;

const client = require('../seap-client');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function safeName(code) {
  return String(code).replace(/[^A-Za-z0-9_-]/g, '_');
}

async function downloadDocs(logs) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const now = new Date();
  const list = client.getNotices();
  const active = list.filter(n =>
    n.advNoticeId && n.details && n.details.hasDocument &&
    (!n.deadline || new Date(n.deadline) >= now) &&
    client.IT_CATEGORIES.has((n.manual && n.category) || client.detectCategory(n.title, n.cpvFull))
  );

  // documentul se descarcă o singură dată per anunț (sau din nou dacă s-a schimbat numele fișierului, ex. erată)
  const todo = active.filter(n => {
    const f = n.details.docFile && path.join(DOCS_DIR, n.details.docFile);
    return !f || !fs.existsSync(f) || n.details.docSourceName !== n.details.documentName;
  });

  let ok = 0;
  let failed = 0;
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const n = todo[i++];
      try {
        const doc = await client.downloadNoticeDocument(n.code);
        const ext = path.extname(doc.fileName) || '.bin';
        const file = `${safeName(n.code)}${ext.toLowerCase()}`;
        fs.writeFileSync(path.join(DOCS_DIR, file), doc.buffer);
        n.details.docFile = file;
        n.details.docDisplayName = doc.fileName;
        n.details.docSourceName = n.details.documentName;
        n.details.docInline = doc.inline;
        ok++;
      } catch (e) {
        failed++;
      }
    }
  }
  await Promise.all([1, 2, 3].map(worker));

  // salvăm câmpurile noi pe lista actuală
  const byCode = new Map(todo.map(n => [n.code, n.details]));
  const latest = client.getNotices();
  for (const n of latest) if (byCode.has(n.code) && n.details) Object.assign(n.details, byCode.get(n.code));
  client.saveNotices(latest);

  // ștergem documentele anunțurilor care nu mai sunt active
  const activeCodes = new Set(active.map(n => n.code));
  const keep = new Set(latest.filter(n => activeCodes.has(n.code) && n.details && n.details.docFile).map(n => n.details.docFile));
  let removed = 0;
  for (const f of fs.readdirSync(DOCS_DIR)) {
    if (!keep.has(f)) { fs.unlinkSync(path.join(DOCS_DIR, f)); removed++; }
  }
  logs.push(`📄 Caiete de sarcini: ${ok} descărcate${failed ? `, ${failed} eșuate` : ''}, ${removed} vechi șterse, ${keep.size} disponibile`);
}

async function main() {
  const state = client.getSyncState();
  const lastFull = state.lastFullSyncAt ? new Date(state.lastFullSyncAt).getTime() : 0;
  const days = Number(process.env.SYNC_DAYS) || (Date.now() - lastFull > 12 * 3600000 || client.getNotices().length === 0 ? 30 : 2);

  console.log(`🔄 Sincronizare SEAP: ultimele ${days} zile`);
  const r = await client.syncWithLiveSEAP({ days });
  for (const l of r.logs) if (!l.startsWith('📥')) console.log('  ', l);
  console.log(`   ${r.fetchedCount} descărcate • ${r.itCount} IT • ${r.itActiveCount} IT active • total ${r.totalCount} (${Math.round(r.durationMs / 1000)}s)`);
  if (!r.success) throw new Error(r.error);

  const logs = [];
  await downloadDocs(logs);
  try {
    const mr = await require('../market').syncMarket({ ifOlderThanHours: 6, log: l => logs.push(l) });
    if (mr.skipped) logs.push(`📊 Piață: neschimbată (${mr.count} înregistrări, actualizare la max. 6 ore)`);
  } catch (e) {
    logs.push(`⚠️ Piață: ${e.message}`);
  }
  logs.forEach(l => console.log('  ', l));

  // ---- site ----
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'public'), SITE_DIR);
  copyDir(DOCS_DIR, path.join(SITE_DIR, 'docs'));
  fs.mkdirSync(path.join(SITE_DIR, 'data'), { recursive: true });

  const cutoff = Date.now() - KEEP_DAYS_ON_SITE * 86400000;
  const notices = client.getNotices()
    .filter(n => new Date(n.deadline || n.publishedAt || Date.now()).getTime() >= cutoff)
    .map(n => {
      const { status, notes, firstSeenAt, ...rest } = n; // statusurile personale nu se publică
      return rest;
    });
  fs.writeFileSync(path.join(SITE_DIR, 'data', 'notices.json'), JSON.stringify(notices));
  const marketFile = path.join(DATA_DIR, 'market.json');
  if (fs.existsSync(marketFile)) fs.copyFileSync(marketFile, path.join(SITE_DIR, 'data', 'market.json'));

  const finalState = client.getSyncState();
  const meta = {
    syncedAt: finalState.lastSyncAt,
    lastFullSyncAt: finalState.lastFullSyncAt,
    lastResult: finalState.lastResult,
    totalCount: notices.length,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(SITE_DIR, 'data', 'meta.json'), JSON.stringify(meta));

  const repo = process.env.GITHUB_REPOSITORY || 'Tavi-Tod/seap-hunter';
  fs.writeFileSync(path.join(SITE_DIR, 'config.js'),
    `window.SEAP_STATIC = ${JSON.stringify({ repo, workflow: 'sync.yml', userDataBranch: 'user-data' })};\n`);
  fs.writeFileSync(path.join(SITE_DIR, '.nojekyll'), '');

  console.log(`✅ Site generat în ${SITE_DIR}: ${notices.length} anunțuri, ${fs.readdirSync(path.join(SITE_DIR, 'docs')).length} documente`);
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
