/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — résolution des photos, une fois pour toutes
   ───────────────────────────────────────────────────────────────
   Usage :
     node resolve-photos.js --test     → 10 combattants, mode verbeux
     node resolve-photos.js            → tout le roster, reprend où il s'est arrêté
     node resolve-photos.js --retry    → réessaie aussi ceux marqués sans photo

   Produit : photos.json  (à committer dans le repo, à côté d'index.html)

   Aucune dépendance, aucune clé API. Node 18+ suffit.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'photos.json');
const TOTT = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_fighter_tott.csv';
const UA = 'FighterHub/1.0 (projet perso non commercial; contact via GitHub)';

const TEST  = process.argv.includes('--test');
const RETRY = process.argv.includes('--retry');
const CONCURRENCY = 3;      // requêtes en parallèle — rester poli
const PAUSE_MS   = 120;     // pause entre chaque lot

/* ─────────────── utilitaires ─────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function slugKey(n){ return (n||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

function deaccent(x){
  return (x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\u0142/gi,'l').replace(/\u00f8/gi,'o').replace(/\u0111/gi,'d')
    .replace(/\u00e6/gi,'ae').replace(/\u0153/gi,'oe').replace(/\u00df/g,'ss')
    .replace(/\u0131/gi,'i').replace(/\u00fe/gi,'th')
    .toLowerCase();
}

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

async function get(url, asText=true){
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': asText ? 'text/html,application/json' : '*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return asText ? r.text() : r;
}

/* ─────────────── SOURCE 1 : UFC.com (découpes officielles) ─────────────── */
function ufcSlug(name){
  return deaccent(name).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

async function fromUFC(name){
  const url = 'https://www.ufc.com/athlete/' + ufcSlug(name);
  let html;
  try { html = await get(url); } catch(e){ return null; }

  const key = deaccent(name.trim().split(/\s+/).pop());
  const first = deaccent(name.trim().split(/\s+/)[0]);

  const all = (style) => {
    const re = new RegExp('https?:\\/\\/[^"\'\\s)<>]*\\/styles\\/' + style + '\\/[^"\'\\s)<>]+', 'gi');
    return [...new Set((html.match(re) || []).map(u => u.replace(/&amp;/g, '&')))];
  };
  // match nom : famille OU prénom présents dans l'URL (certaines découpes n'ont que le prénom, ex. O'Malley)
  const mine = list => list.find(u => {
    const du = deaccent(u);
    return (key.length>2 && du.includes(key)) || (first.length>2 && du.includes(first));
  }) || null;

  const heads = all('event_results_athlete_headshot');
  // headshot : si un seul sur la page ET qu'on est sur la bonne fiche, on l'accepte
  const head  = mine(heads) || (heads.length===1 ? heads[0] : null);

  const fulls = all('athlete_bio_full_body');
  const full  = mine(fulls) || (fulls.length === 1 ? fulls[0] : null);

  // ── pays : extrait du bloc "Place of Birth" (format "Ville, Pays") ──
  let country = null;
  let birth = null;
  // on cherche "Place of Birth" puis on capture le texte du prochain élément non vide
  let m = html.match(/Place of Birth[\s\S]{0,120}?>\s*([A-Za-z][A-Za-z .,'\/-]{2,60}?)\s*</i);
  if(m) birth = m[1];
  // repli : champ "hometown" / "birthplace"
  if(!birth){ m = html.match(/(?:hometown|birthplace)["'>\s:]{1,8}([A-Za-z][A-Za-z .,'\/-]{2,60}?)\s*</i); if(m) birth = m[1]; }
  if(birth){
    birth = birth.replace(/\s+/g,' ').trim();
    // "Ville, Pays" -> on garde le dernier segment (le pays)
    const parts = birth.split(',').map(x=>x.trim()).filter(Boolean);
    let cand = parts.length ? parts[parts.length-1] : birth;
    // garde-fous : pas de chiffre, longueur raisonnable, pas un mot vide
    if(cand && !/\d/.test(cand) && cand.length>=3 && cand.length<=32) country = cand;
  }

  // ── surnom : plusieurs formats possibles sur UFC.com ──
  let nick = null;
  let nm;
  // 1) attribut/texte "nickname" suivi d'une valeur entre guillemets
  nm = html.match(/nickname[^"'A-Za-z]{0,15}["']([A-Za-z][A-Za-z0-9 .'\/-]{1,28}?)["']/i);
  // 2) class="nickname">valeur<  (avec guillemets optionnels autour de la valeur)
  if(!nm) nm = html.match(/class=["'][^"']*nickname[^"']*["'][^>]*>\s*["']?([A-Za-z][A-Za-z0-9 .'\/-]{1,28}?)["']?\s*</i);
  // 3) mot "nickname" puis > valeur <
  if(!nm) nm = html.match(/nickname[">\s:]{1,10}([A-Z][A-Za-z0-9 .'\/-]{1,28}?)\s*</i);
  // 4) hero-profile__tag (badge sous le nom sur la fiche UFC)
  if(!nm) nm = html.match(/hero-profile__tag[^>]*>\s*["']?([A-Za-z][A-Za-z0-9 .'\/-]{1,28}?)["']?\s*</i);
  if(nm) nick = nm[1].trim();
  if(nick){
    nick = nick.replace(/\s+/g,' ').trim();
    // garde-fou : pas juste un mot vide ou une répétition du nom de famille
    if(nick.length<2 || /^\d/.test(nick) || deaccent(nick).toLowerCase()===key.toLowerCase()) nick = null;
  }

  if(head || full || country || nick) return { src: head || full, head, full, country, nick, source:'ufc' };

  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if(og && deaccent(og[1]).includes(key)) {
    const u = og[1].replace(/&amp;/g,'&');
    return { src:u, head:null, full:u, country:null, nick:null, source:'ufc-og' };
  }
  return null;
}

/* ─────────────── SOURCE 2 : Wikipedia (repli) ─────────────── */
const MMA_RE = /mixed martial|martial artist|\bufc\b|\bmma\b|kickbox|\bfighter\b|\bboxer\b|grappler|wrestler|jiu-?jitsu|bellator|octagon|welterweight|middleweight|heavyweight|lightweight|bantamweight|featherweight|flyweight|strawweight/i;
const DISAMBIG_RE = /\bmay refer to\b|\bcan refer to\b|refer to:/i;
const PARTICLES = new Set(['Dos','Das','Da','Do','De','Del','Della','Di','Van','Von','Der','Den','Du','La','Le','Ter','Bin','Al','St','Mc']);

function titleVariants(name){
  const out=[name];
  const w=name.split(' ');
  const low=w.map((x,i)=> i>0 && PARTICLES.has(x) ? x.toLowerCase() : x).join(' ');
  if(low!==name) out.push(low);
  out.push(name+' (fighter)');
  out.push(name+' (mixed martial artist)');
  return out;
}

function isFighterPage(title, extract){
  const ex = extract||'';
  if(DISAMBIG_RE.test(ex)) return false;
  if(/\((fighter|mixed martial artist|martial artist|mma fighter)\)/i.test(title||'')) return true;
  return MMA_RE.test(ex);
}

const WIKI_PROPS = '&prop=pageimages%7Cextracts&piprop=thumbnail&pithumbsize=640&pilimit=50'
                 + '&exintro=1&explaintext=1&exsentences=3&exlimit=20';

async function wikiByTitle(title){
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
            + WIKI_PROPS + '&titles=' + encodeURIComponent(title);
  const j = JSON.parse(await get(url));
  const pages = Object.values(j.query?.pages || {});
  for(const pg of pages){
    if(pg.missing!==undefined || !pg.thumbnail) continue;
    if(!isFighterPage(pg.title, pg.extract)) continue;
    const t=pg.thumbnail;
    return { src:t.source, w:t.width||0, h:t.height||0, source:'wikipedia' };
  }
  return null;
}

async function wikiBySearch(name){
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json'
            + '&generator=search&gsrnamespace=0&gsrlimit=3'
            + '&gsrsearch=' + encodeURIComponent(name+' mixed martial artist')
            + WIKI_PROPS;
  const j = JSON.parse(await get(url));
  const pages = Object.values(j.query?.pages || {}).sort((a,b)=>(a.index||99)-(b.index||99));
  const last = deaccent(name.trim().split(/\s+/).pop());
  for(const pg of pages){
    if(!pg.thumbnail) continue;
    if(!isFighterPage(pg.title, pg.extract)) continue;
    if(last.length>2 && !deaccent(pg.title).includes(last)) continue;
    const t=pg.thumbnail;
    return { src:t.source, w:t.width||0, h:t.height||0, source:'wikipedia-search' };
  }
  return null;
}

async function fromWikipedia(name){
  for(const t of titleVariants(name)){
    try { const r = await wikiByTitle(t); if(r) return r; } catch(e){}
  }
  try { return await wikiBySearch(name); } catch(e){ return null; }
}

/* ─────────────── résolution d'un combattant ─────────────── */
async function resolve(name){
  try { const u = await fromUFC(name); if(u) return u; } catch(e){}
  try { const w = await fromWikipedia(name); if(w) return w; } catch(e){}
  return null;
}

/* ─────────────── programme principal ─────────────── */
(async function main(){
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FIGHTER HUB — résolution des photos         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('→ Téléchargement de la liste des combattants…');
  const rows = parseCSV(await get(TOTT)).filter(r=>r.length>1);
  const head = rows.shift();
  const iName = head.findIndex(h=>h.trim().toUpperCase().includes('FIGHTER'));
  if(iName < 0){ console.error('✖ Colonne FIGHTER introuvable. En-têtes :', head); process.exit(1); }

  const seen = new Set();
  let names = [];
  for(const r of rows){
    const n = (r[iName]||'').trim();
    if(!n) continue;
    const k = slugKey(n);
    if(seen.has(k)) continue;
    seen.add(k);
    names.push(n);
  }
  console.log(`  ${names.length} combattants uniques\n`);

  // reprise : on repart de photos.json s'il existe
  let db = {};
  if(fs.existsSync(OUT)){
    try {
      db = JSON.parse(fs.readFileSync(OUT,'utf8'));
      console.log(`→ photos.json existant : ${Object.keys(db).length} entrées déjà traitées`);
    } catch(e){ console.log('→ photos.json illisible, on repart de zéro'); }
  }

  let todo = names.filter(n=>{
    const e = db[slugKey(n)];
    if(e === undefined) return true;      // jamais tenté
    if(RETRY && e === null) return true;  // déjà tenté sans succès, on réessaie
    return false;
  });

  if(TEST){
    todo = todo.slice(0, 10);
    console.log('\n⚠ MODE TEST — 10 combattants seulement, rien n\'est écrit dans photos.json\n');
  }

  if(!todo.length){
    console.log('\n✓ Rien à faire, tout est déjà résolu.');
    console.log('  (relance avec --retry pour réessayer les combattants sans photo)\n');
    return;
  }

  console.log(`→ À traiter : ${todo.length}\n`);

  const stats = { ufc:0, 'ufc-og':0, wikipedia:0, 'wikipedia-search':0, aucune:0 };
  let done = 0;
  const t0 = Date.now();

  for(let i=0; i<todo.length; i+=CONCURRENCY){
    const lot = todo.slice(i, i+CONCURRENCY);
    const res = await Promise.all(lot.map(async n => [n, await resolve(n)]));

    for(const [n, r] of res){
      db[slugKey(n)] = r;
      stats[r ? r.source : 'aucune']++;
      done++;
      if(TEST){
        console.log(`  ${r ? '✓' : '✖'} ${n.padEnd(26)} ${r ? '['+r.source+'] '+r.src.slice(0,78) : '— aucune photo trouvée'}`);
      }
    }

    if(!TEST && (done % 30 === 0 || done === todo.length)){
      fs.writeFileSync(OUT, JSON.stringify(db));   // sauvegarde régulière
      const pct = (done/todo.length*100).toFixed(1);
      const perSec = done / ((Date.now()-t0)/1000);
      const reste = Math.round((todo.length-done)/perSec/60);
      process.stdout.write(`\r  ${done}/${todo.length} (${pct}%) — trouvées : ${done-stats.aucune} — reste ~${reste} min   `);
    }

    await sleep(PAUSE_MS);
  }

  if(!TEST){
    fs.writeFileSync(OUT, JSON.stringify(db));
    console.log('\n');
  }

  const total = done;
  const ok = total - stats.aucune;
  console.log('\n─── Résultat ───');
  console.log(`  UFC.com (découpe officielle) : ${stats.ufc + stats['ufc-og']}`);
  console.log(`  Wikipedia                    : ${stats.wikipedia + stats['wikipedia-search']}`);
  console.log(`  Aucune photo                 : ${stats.aucune}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Taux de couverture           : ${(ok/total*100).toFixed(1)}%`);

  if(TEST){
    console.log('\n→ Test terminé, aucun fichier écrit.');
    console.log('  Si les résultats te vont : node resolve-photos.js\n');
  } else {
    console.log(`\n✓ photos.json écrit (${(fs.statSync(OUT).size/1024).toFixed(0)} Ko)`);
    console.log('  Commit-le dans le repo à côté d\'index.html.\n');
  }
})().catch(e=>{
  console.error('\n✖ Erreur fatale :', e.message);
  console.error('  Relance la commande, le script reprend où il s\'est arrêté.\n');
  process.exit(1);
});
