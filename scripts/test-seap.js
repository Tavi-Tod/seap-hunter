// Test: poate serverul curent (ex. GitHub Actions) să acceseze API-ul public SEAP?
const { syncWithLiveSEAP, getNoticeDetails, downloadNoticeDocument, filterNotices } = require('../seap-client');
(async () => {
  const t0 = Date.now();
  const r = await syncWithLiveSEAP({ days: 2 });
  console.log('sync', JSON.stringify({ ok: r.success, err: r.error, fetched: r.fetchedCount, it: r.itCount, details: r.detailsCount, ms: Date.now() - t0 }));
  if (!r.success) process.exit(1);
  const it = filterNotices({ scope: 'it' }).opportunities.filter(o => o.details && o.details.hasDocument);
  if (it[0]) {
    const doc = await downloadNoticeDocument(it[0].code);
    console.log('document', it[0].code, doc.fileName, doc.contentType, doc.buffer.length);
  }
})().catch(e => { console.error('EROARE', e); process.exit(1); });
