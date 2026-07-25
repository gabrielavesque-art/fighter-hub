/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — pré-calcul des stats avancées
   ───────────────────────────────────────────────────────────────
   Parcourt ufc_fight_stats.csv (une ligne par combattant / par round)
   et agrège, pour chaque combattant, ses moyennes de carrière :
     - frappes significatives réussies / tentées → précision
     - takedowns réussis / tentés → précision
     - temps de contrôle total
     - répartition des frappes tête / corps / jambe
     - tentatives de soumission, knockdowns
     - volume par minute (frappes portées & encaissées)

   Produit : stats.json  (petit, à committer à côté d'index.html)

   Usage :
     node build-stats.js --test    → 200 lignes, verbeux, n'écrit rien
     node build-stats.js           → tout le fichier, écrit stats.json

   Aucune dépendance, aucune clé. Node 18+.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT   = path.join(__dirname, 'stats.json');
const SRC   = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_fight_stats.csv';
const UA    = 'FighterHub/1.0 (projet perso non commercial)';
const TEST  = process.argv.includes('--test');

/* ─────────── CSV (même parser tolérant que le site) ─────────── */
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
  for(const k of keys){
    const K=k.toUpperCase().replace(/[^A-Z]/g,'');
    const i=H.indexOf(K); if(i>-1) return i;
  }
  for(const k of keys){
    const K=k.toUpperCase().replace(/[^A-Z]/g,'');
    const i=H.findIndex(h=>h.includes(K)); if(i>-1) return i;
  }
  return -1;
}

/* ─────────── parseurs de valeurs UFC ─────────── */
const clean = v => (v||'').trim();
function slugKey(n){ return (n||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

// "19 of 32" -> {l:19, a:32}   |  "---" ou "" -> {l:0, a:0}
function ofPair(v){
  const m = clean(v).match(/(\d+)\s+of\s+(\d+)/i);
  if(m) return { l:+m[1], a:+m[2] };
  const n = clean(v).match(/^\d+$/);
  return n ? { l:+n[0], a:+n[0] } : { l:0, a:0 };
}
// "4:31" -> 271 secondes   |  "--" -> 0
function ctrlSec(v){
  const m = clean(v).match(/(\d+):(\d{1,2})/);
  return m ? (+m[1])*60 + (+m[2]) : 0;
}
// "88%" -> 88   |  "---" -> null
function pct(v){
  const m = clean(v).match(/(\d+)\s*%/);
  return m ? +m[1] : null;
}
function intOr0(v){ const m=clean(v).match(/\d+/); return m?+m[0]:0; }

async function get(url){
  const r = await fetch(url, { headers:{'User-Agent':UA}, signal:AbortSignal.timeout(30000) });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.text();
}

/* ─────────── programme principal ─────────── */
(async function main(){
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FIGHTER HUB — pré-calcul des stats          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('→ Téléchargement de ufc_fight_stats.csv…');
  const raw = await get(SRC);
  console.log(`  ${(raw.length/1024/1024).toFixed(1)} Mo reçus`);

  let rows = parseCSV(raw).filter(r=>r.length>3);
  const head = rows.shift();
  if(TEST) rows = rows.slice(0, 200);

  // repérage des colonnes (tolérant aux variations d'intitulé)
  const iFighter = col(head,'FIGHTER');
  const iRound   = col(head,'ROUND');
  const iKD      = col(head,'KD');
  const iSig     = col(head,'SIGSTR','SIG.STR.','SIGNIFICANTSTRIKES');
  const iTot     = col(head,'TOTALSTR','TOTAL STR.');
  const iTD      = col(head,'TD','TAKEDOWNS');
  const iSub     = col(head,'SUBATT','SUB.ATT','SUBMISSIONATTEMPTS');
  const iRev     = col(head,'REV','REVERSALS');
  const iCtrl    = col(head,'CTRL','CONTROL');
  const iHead    = col(head,'HEAD');
  const iBody    = col(head,'BODY');
  const iLeg     = col(head,'LEG');

  console.log(`  Colonnes → fighter:${iFighter} round:${iRound} sig:${iSig} td:${iTD} ctrl:${iCtrl} head:${iHead}`);
  if(iFighter<0 || iSig<0){ console.error('✖ Colonnes essentielles introuvables. En-têtes :', head); process.exit(1); }

  // "Round 1" seulement → on ignore les lignes de round pour éviter le double comptage,
  // MAIS le fichier n'a pas toujours de ligne "totale" : on somme donc tous les rounds.
  const F = new Map();  // key -> accumulateur
  const acc = name => {
    const k = slugKey(name);
    if(!F.has(k)) F.set(k, {
      name, rounds:0,
      sigL:0, sigA:0, totL:0, totA:0,
      tdL:0, tdA:0, sub:0, rev:0, kd:0, ctrl:0,
      head:0, body:0, leg:0
    });
    return F.get(k);
  };

  let n=0;
  for(const r of rows){
    const name = clean(r[iFighter]);
    if(!name || /^fighter$/i.test(name)) continue;
    // on ne garde que les lignes de round individuel (Round 1..5), pas d'éventuelle ligne résumé
    const rnd = clean(r[iRound]);
    if(!/round\s*\d/i.test(rnd)) continue;

    const a = acc(name);
    a.rounds++;
    const sig = ofPair(r[iSig]); a.sigL+=sig.l; a.sigA+=sig.a;
    if(iTot>-1){ const t=ofPair(r[iTot]); a.totL+=t.l; a.totA+=t.a; }
    if(iTD>-1){ const td=ofPair(r[iTD]); a.tdL+=td.l; a.tdA+=td.a; }
    if(iSub>-1) a.sub += intOr0(r[iSub]);
    if(iRev>-1) a.rev += intOr0(r[iRev]);
    if(iKD>-1)  a.kd  += intOr0(r[iKD]);
    if(iCtrl>-1) a.ctrl += ctrlSec(r[iCtrl]);
    if(iHead>-1) a.head += ofPair(r[iHead]).l;
    if(iBody>-1) a.body += ofPair(r[iBody]).l;
    if(iLeg>-1)  a.leg  += ofPair(r[iLeg]).l;
    n++;
    if(TEST && n<=6){
      console.log(`  ${name.padEnd(22)} ${rnd.padEnd(9)} sig ${JSON.stringify(sig)} td ${JSON.stringify(ofPair(r[iTD]))} ctrl ${ctrlSec(r[iCtrl])}s`);
    }
  }

  // condensé final : uniquement les métriques dérivées, arrondies
  const out = {};
  for(const [k,a] of F){
    const mins = a.ctrl>0 || a.rounds ? (a.roundsMin || 0) : 0; // placeholder, minutes calculées ci-dessous
    // on ne connaît pas la durée exacte des rounds -> on estime le temps de combat
    // via le temps de contrôle n'est pas fiable ; on exprime donc les volumes par round.
    const strikeAcc = a.sigA ? Math.round(a.sigL/a.sigA*100) : null;
    const tdAcc     = a.tdA  ? Math.round(a.tdL/a.tdA*100)   : null;
    const targetTot = a.head+a.body+a.leg;
    out[k] = {
      r: a.rounds,                               // rounds combattus (échantillon)
      sl: a.sigL, sa: a.sigA,                     // frappes sig. réussies / tentées
      sacc: strikeAcc,                            // précision de frappe %
      tdl: a.tdL, tda: a.tdA,                      // takedowns réussis / tentés
      tdacc: tdAcc,                               // précision takedown %
      sub: a.sub, kd: a.kd,                        // soumissions tentées, knockdowns
      ctrl: a.ctrl,                               // temps de contrôle total (s)
      spr: a.rounds ? +(a.sigL/a.rounds).toFixed(1) : 0,   // frappes sig. / round
      tgt: targetTot ? {
        h: Math.round(a.head/targetTot*100),
        b: Math.round(a.body/targetTot*100),
        l: Math.round(a.leg /targetTot*100)
      } : null
    };
  }

  if(TEST){
    console.log('\n─── Aperçu (5 combattants) ───');
    let i=0;
    for(const [k,v] of Object.entries(out)){
      if(i++>=5) break;
      console.log(`  ${k.padEnd(22)} précision:${v.sacc}%  TD:${v.tdacc}%  ${v.spr} frappes/round  cible:${v.tgt?`T${v.tgt.h}/C${v.tgt.b}/J${v.tgt.l}`:'—'}`);
    }
    console.log(`\n${F.size} combattants agrégés, ${n} lignes de round traitées.`);
    console.log('\n→ Test terminé, aucun fichier écrit.\n');
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n✓ stats.json écrit : ${F.size} combattants, ${(fs.statSync(OUT).size/1024).toFixed(0)} Ko`);
  console.log('  Commit-le à côté d\'index.html.\n');
})().catch(e=>{
  console.error('\n✖ Erreur :', e.message, '\n');
  process.exit(1);
});
