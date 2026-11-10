#!/usr/bin/env node
/**
 * SEAP Hunter — CLI
 * Rulează:
 *   node scraper.js                 → sincronizează ultimele 30 zile și afișează anunțurile IT în desfășurare
 *   node scraper.js 14              → doar ultimele 14 zile
 *   node scraper.js 30 --all        → toate domeniile (nu doar IT)
 *   node scraper.js 30 --expired    → anunțurile IT expirate
 *   node scraper.js 30 --from=2026-11-01 --to=2026-11-10   → filtru pe data publicării
 */
const { syncWithLiveSEAP, filterNotices } = require('./seap-client');

const args = process.argv.slice(2);
const days = Number(args.find(a => /^\d+$/.test(a))) || 30;
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];

async function run() {
  console.log(`\n🔍 Se descarcă anunțurile din e-licitatie.ro → Publicitate anunțuri (ultimele ${days} zile)...`);
  const r = await syncWithLiveSEAP({ days });
  if (!r.success) console.log(`❌ ${r.error}`);
  console.log(`   ${r.fetchedCount} anunțuri descărcate • ${r.itCount} IT • ${r.itActiveCount} IT în desfășurare\n`);

  const { opportunities, counts } = filterNotices({
    scope: args.includes('--all') ? 'all' : 'it',
    state: args.includes('--expired') ? 'expired' : args.includes('--any') ? 'all' : 'active',
    pubFrom: opt('from'),
    pubTo: opt('to')
  });

  const fmt = iso => (iso ? new Date(iso).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
  for (const o of opportunities) {
    console.log(`[${o.code}] ${o.categoryLabel} | ${o.estimatedValueRON.toLocaleString('ro-RO')} RON | termen ${fmt(o.deadline)}`);
    console.log(`   ${o.title}`);
    console.log(`   🏛️  ${o.authority} • ${o.seapUrl}\n`);
  }
  console.log(`📊 ${opportunities.length} anunțuri afișate (site-uri: ${counts.web_registratura}, software/servicii: ${counts.software_gestiune}, echipamente/rețele: ${counts.hardware_it}, kituri: ${counts.smart_lab_kits})\n`);
}

run().catch(err => console.error('Eroare:', err));
