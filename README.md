# 🇷🇴 SEAP Hunter PNRR — Achiziții Directe (e-licitatie.ro)
**Digitalizare Primării/Școli, Aplicații Arhivă Digitală & Kituri Smart Lab (Arduino / ESP32)**

Acest instrument îți extrage, filtrează și calculează profitul pe cele **3 nișe cu marjă de 85%–98%** din Achizițiile Directe SEAP (`e-licitatie.ro` -> *Publicitate Anunțuri ADV* & *Cumpărări Directe*), plus îți generează **în 1-Click** pachetul complet de ofertare (Titlu Catalog SEAP, Email de Înaintare și Propunere Tehnică + Deviz Financiar gata de PDF).

---

## 🚀 Pornire Rapidă (în 5 secunde)

### Varianta 1: Dublu-click pe `start-hunter.bat`
Deschide automat serverul local și interfața web în browser la **[http://localhost:3080](http://localhost:3080)**.

### Varianta 2: Din terminal
```bash
# Pornește dashboard-ul web pe http://localhost:3080
npm start

# Sau rulează hunter-ul direct în linia de comandă:
npm run hunt
```

---

## 🔎 Cum funcționează (versiunea actuală)

- La pornire, serverul descarcă **toate** anunțurile din *e-licitatie.ro → Publicitate anunțuri* din ultimele **30 de zile** (API public `GetAdvNoticeList`), apoi verifică automat la fiecare 30 de minute.
- Fiecare anunț e clasificat automat după **cod CPV + cuvinte din titlu**:
  🌐 Site-uri & portaluri • 🧩 Software, aplicații & servicii IT • 🖥️ Echipamente & rețele • 🤖 Kituri/robotică • 📋 Non-IT
- **Filtre în interfață:**
  - Stare: *Doar în desfășurare* (termen limită încă neexpirat — implicit), *Doar expirate*, *Toate*
  - Data publicării (de la / până la) și termenul limită de ofertare (de la / până la)
  - Valoare minimă / maximă (RON), căutare text, status personal
  - Butoane rapide: *Publicate azi*, *ultimele 3/7 zile*, *Expiră în 3/7 zile*
- Fiecare card are buton **↗ Deschide în SEAP**, care duce direct la pagina anunțului (cu caietul de sarcini).
- Pe fiecare card IT în desfășurare apar direct **condițiile de participare** și **criteriul de atribuire** (plus, la cerere, descrierea, condițiile de contract, informațiile suplimentare și datele de contact). Se aduc automat la sincronizare; pentru alte anunțuri, butonul „Vezi condițiile de acceptare” le încarcă la cerere.
- **📄 Vezi caietul de sarcini** deschide documentul atașat anunțului. Dacă e semnat electronic (`.pdf.p7s`), serverul extrage PDF-ul ca să se deschidă direct în browser. Link-ul „original semnat” descarcă fișierul exact cum e în SEAP.
- **Export CSV** exportă exact lista filtrată.

Pe macOS: dublu-click pe `start-hunter.command` (sau `npm start`). CLI: `npm run hunt` (opțiuni: `node scraper.js 14 --all --from=2026-11-01`).

Datele locale stau în `data/notices.json`. Profitul/marja afișate sunt **estimări orientative**, nu date din SEAP.

---

## 📱 Versiunea online (telefon, fără laptop pornit)

**Link:** https://tavi-tod.github.io/seap-hunter/

- Rulează gratuit pe GitHub: **GitHub Actions** (`.github/workflows/sync.yml`) descarcă anunțurile din SEAP la ~30 de minute, aduce condițiile și caietele de sarcini (PDF extras din `.p7s`), apoi publică pagina pe **GitHub Pages**.
- Baza de date se păstrează pe ramura `data`; statusurile tale („În analiză”, „Ofertă trimisă”…) pe ramura `user-data`.
- **Actualizează acum** pornește imediat workflow-ul (anunțurile din ultimele 2 zile) și reîncarcă lista în ~1–3 minute.

### Conectarea telefonului (o singură dată pe fiecare dispozitiv)
1. Deschide https://github.com/settings/personal-access-tokens/new
2. *Repository access* → **Only select repositories** → `seap-hunter`
3. *Permissions → Repository*: **Actions: Read and write**, **Contents: Read and write**
4. *Generate token* → copiază-l → în pagină apasă **🔑 GitHub** și lipește-l.

Fără token pagina funcționează (listă, filtre, condiții, caiete de sarcini), dar fără „Actualizează acum” și cu statusurile salvate doar local pe acel dispozitiv.

**De știut:** repository-ul este public (anunțurile SEAP sunt oricum publice; statusurile din `user-data` sunt și ele vizibile). Datele firmei pentru oferte rămân doar în browserul dispozitivului. Adăugarea manuală și importul CSV există doar în versiunea de pe laptop.

---

## 🎯 Cele 3 Nișe Monitorizate (0 Cerșeală — Banii sunt deja în contul instituției)

1. **🌐 Site Web Primărie / Școală + Modul Registratură Online & Monitorul Oficial Local (MOL)**
   - **Cod CPV:** `72413000-8`
   - **Bugete tipice SEAP:** `10.000 – 25.000 RON`
   - **Costul tău:** `~300 – 450 RON` (domeniu `.ro` + găzduire NVMe) + 1–2 după-amieze configurare template UAT/Școală.

2. **💻 Aplicații Gestiune / Programări Online / Arhivă Digitală cu OCR (DMS)**
   - **Coduri CPV:** `48311000-1`, `72212000-4`
   - **Bugete tipice SEAP:** `20.000 – 50.000 RON`
   - **Costul tău:** `~600 – 1.200 RON` (deploy aplicație web + configurare nomenclatoare).

3. **🤖 Kituri Laborator Inteligent (Smart Lab PNRR) / Robotică / Senzori Arduino & ESP32**
   - **Coduri CPV:** `39162100-6`, `38970000-5`
   - **Bugete tipice SEAP:** `20.000 – 45.000 RON` (30–50 kituri × `550 – 800 RON/buc`)
   - **Costul tău:** `~75 – 90 RON/buc` (placă ESP32/Arduino UNO + set 15 senzori + cutie organizatoare din plastic + manual PDF cu 10 lecții în limba română).
