/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — calcul du classement ELO
   ───────────────────────────────────────────────────────────────
   1. joint la date de chaque combat (ufc_event_details.csv)
   2. trie tous les combats du plus ancien au plus récent
   3. déroule les combats : tout le monde à 1000, le vainqueur
      prend des points au perdant (K ajusté par la finition)
   4. mémorise ELO courant, pic historique, et delta par combat

   Produit : elo.json  (petit, à committer à côté d'index.html)

   Usage :
     node build-elo.js --test    → n'écrit rien, montre le top 25 + contrôles
     node build-elo.js           → écrit elo.json

   Aucune dépendance, aucune clé. Node 18+.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT     = path.join(__dirname, 'elo.json');
const RESULTS = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_fight_results.csv';
const EVENTS  = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_event_details.csv';
const UA      = 'FighterHub/1.0 (projet perso non commercial)';
const TEST    = process.argv.includes('--test');

/* ─────────── paramètres ELO ─────────── */
const START   = 1000;   // ELO de départ
const K_BASE  = 32;     // amplitude de base d'un combat
const K_MIN   = 24;     // pour une décision serrée
const K_KO    = 42;     // pour un KO/TKO
const K_SUB   = 40;     // pour une soumission

/* ─────────── CSV (parser tolérant, identique au site) ─────────── */
function parseCSV(text){
  const rows=[]; let row=[], f='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; }
      else f+=c;
    } else {
      if(c==='"' && f==='') q=true;
      else if(c==='"') f+='"';
      else if(c===','){ row.push(f); f=''; }
      else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; }
      else if(c!=='\r') f+=c;
    }
  }
  if(f!==''||row.length){ row.push(f); rows.push(row); }
  return rows;
}
function col(headers, ...keys){
  const H = headers.map(h=>h.trim().toUpperCase().replace(/[^A-Z]/g,''));
  for(const k of keys){ const K=k.toUpperCase().replace(/[^A-Z]/g,''); const i=H.indexOf(K); if(i>-1) return i; }
  for(const k of keys){ const K=k.toUpperCase().replace(/[^A-Z]/g,''); const i=H.findIndex(h=>h.includes(K)); if(i>-1) return i; }
  return -1;
}
const clean = v => (v||'').trim();
function slugKey(n){ return (n||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

// "December 09, 2023" ou "2023-12-09" -> timestamp (ms). Renvoie NaN si illisible.
function parseDate(v){
  const s = clean(v);
  if(!s) return NaN;
  const t = Date.parse(s);
  return isNaN(t) ? NaN : t;
}

// choisit le K selon la méthode de fin
function kFor(method){
  const m = (method||'').toUpperCase();
  if(m.includes('KO') || m.includes('TKO')) return K_KO;
  if(m.includes('SUB')) return K_SUB;
  if(m.includes('DEC')){
    if(m.includes('SPLIT') || m.includes('MAJORITY')) return K_MIN;  // décision serrée
    return K_BASE;
  }
  return K_BASE;
}

async function get(url){
  const r = await fetch(url, { headers:{'User-Agent':UA}, signal:AbortSignal.timeout(30000) });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.text();
}

/* ─────────── programme principal ─────────── */
(async function main(){
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FIGHTER HUB — calcul ELO                    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── 1. dates des événements ──
  console.log('→ Événements…');
  const evRows = parseCSV(await get(EVENTS)).filter(r=>r.length>1);
  const evHead = evRows.shift();
  const iEvName = col(evHead,'EVENT','NAME');
  const iEvDate = col(evHead,'DATE');
  const dateOf = new Map();
  for(const r of evRows){
    const name = clean(r[iEvName]);
    const d = parseDate(r[iEvDate]);
    if(name && !isNaN(d)) dateOf.set(name, d);
  }
  console.log(`  ${dateOf.size} événements datés`);

  // ── 2. combats ──
  console.log('→ Combats…');
  const fRows = parseCSV(await get(RESULTS)).filter(r=>r.length>1);
  const fHead = fRows.shift();
  const iEvent = col(fHead,'EVENT');
  const iBout  = col(fHead,'BOUT');
  const iOut   = col(fHead,'OUTCOME');
  const iMeth  = col(fHead,'METHOD');

  let fights = [];
  let undated = 0;
  for(const r of fRows){
    const bout = clean(r[iBout]);
    if(!bout) continue;
    const parts = bout.split(/\s+vs\.?\s+/i);
    if(parts.length!==2) continue;
    const a=clean(parts[0]), b=clean(parts[1]);
    const outcome = clean(r[iOut]).toUpperCase();      // "W/L", "L/W", "D/D", "NC/NC"
    const [oa] = outcome.split('/').map(x=>(x||'').trim());
    const event = clean(r[iEvent]);
    const method = clean(r[iMeth]);
    const date = dateOf.has(event) ? dateOf.get(event) : NaN;
    if(isNaN(date)){ undated++; }
    fights.push({ a, b, oa, method, event, date });
  }
  console.log(`  ${fights.length} combats (${undated} sans date -> placés en fin)`);

  // ── 2b. tri chronologique (les sans-date en dernier, ordre du fichier) ──
  fights.forEach((f,i)=>f._i=i);
  fights.sort((x,y)=>{
    const dx = isNaN(x.date)?Infinity:x.date;
    const dy = isNaN(y.date)?Infinity:y.date;
    return dx-dy || x._i-y._i;
  });

  // ── 3. déroulement ELO ──
  const elo = new Map();      // key -> rating courant
  const peak = new Map();     // key -> pic
  const hist = new Map();     // key -> [{d:delta, r:ratingAprès, opp, res, date}]
  const nameOf = new Map();

  const get1 = k => elo.has(k)?elo.get(k):START;
  const expected = (ra,rb)=> 1/(1+Math.pow(10,(rb-ra)/400));

  for(const f of fights){
    const ka=slugKey(f.a), kb=slugKey(f.b);
    if(!ka||!kb) continue;
    nameOf.set(ka,f.a); nameOf.set(kb,f.b);

    const ra=get1(ka), rb=get1(kb);
    const ea=expected(ra,rb), eb=1-ea;

    // score réel selon l'issue du combattant A
    let sa;
    if(f.oa==='W') sa=1;
    else if(f.oa==='L') sa=0;
    else sa=0.5;                     // nul ou no-contest -> demi-point partagé

    // K commun au combat, majoré par la finition
    const K = (f.oa==='W'||f.oa==='L') ? kFor(f.method) : K_MIN;

    const na = Math.round(ra + K*(sa-ea));
    const nb = Math.round(rb + K*((1-sa)-eb));
    elo.set(ka,na); elo.set(kb,nb);

    peak.set(ka, Math.max(peak.has(ka)?peak.get(ka):START, na));
    peak.set(kb, Math.max(peak.has(kb)?peak.get(kb):START, nb));

    const push=(k,delta,rating,opp,resChar,date)=>{
      if(!hist.has(k)) hist.set(k,[]);
      hist.get(k).push({ d:delta, r:rating, opp, res:resChar, date:isNaN(date)?null:date });
    };
    const resA = f.oa==='W'?'W':f.oa==='L'?'L':f.oa==='D'?'D':'N';
    const resB = f.oa==='W'?'L':f.oa==='L'?'W':f.oa==='D'?'D':'N';
    push(ka, na-ra, na, f.b, resA, f.date);
    push(kb, nb-rb, nb, f.a, resB, f.date);
  }

  // ── 4. condensé ──
  const out = {};
  for(const [k,r] of elo){
    const h = hist.get(k)||[];
    out[k] = {
      elo: r,
      peak: peak.get(k)||r,
      n: h.length,
      // 6 derniers deltas pour tracer la trajectoire récente
      trend: h.slice(-6).map(x=>x.d)
    };
  }

  if(TEST){
    const ranked = Object.entries(out)
      .filter(([k,v])=>v.n>=5)                 // au moins 5 combats pour le classement
      .sort((a,b)=>b[1].elo-a[1].elo);
    console.log('\n─── TOP 25 pound-for-pound (ELO courant) ───');
    ranked.slice(0,25).forEach(([k,v],i)=>{
      console.log(`  ${String(i+1).padStart(2)}. ${(nameOf.get(k)||k).padEnd(24)} ${v.elo}  (pic ${v.peak}, ${v.n} combats)`);
    });

    console.log('\n─── Pic historique le plus haut ───');
    Object.entries(out).sort((a,b)=>b[1].peak-a[1].peak).slice(0,8)
      .forEach(([k,v],i)=>console.log(`  ${i+1}. ${(nameOf.get(k)||k).padEnd(24)} pic ${v.peak} (actuel ${v.elo})`));

    // contrôles de cohérence
    console.log('\n─── Contrôles ───');
    const vals = Object.values(out).map(v=>v.elo);
    const around1000 = vals.filter(v=>Math.abs(v-1000)<5).length;
    console.log(`  ${Object.keys(out).length} combattants classés`);
    console.log(`  ELO min ${Math.min(...vals)} · max ${Math.max(...vals)}`);
    console.log(`  ${around1000} combattants à ~1000 (attendu : ceux à 1 seul combat équilibré)`);
    console.log('\n→ Test terminé, aucun fichier écrit.\n');
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n✓ elo.json écrit : ${Object.keys(out).length} combattants, ${(fs.statSync(OUT).size/1024).toFixed(0)} Ko`);
  console.log('  Commit-le à côté d\'index.html.\n');
})().catch(e=>{
  console.error('\n✖ Erreur :', e.message, '\n');
  process.exit(1);
});
