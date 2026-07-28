/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — résolution des photos, une fois pour toutes
   ───────────────────────────────────────────────────────────────
   Usage :
     node resolve-photos.js --test     → 10 combattants, mode verbeux
     node resolve-photos.js            → complète : traite ceux jamais tentés
     node resolve-photos.js --retry    → réessaie aussi ceux marqués sans photo
     node resolve-photos.js --force    → RECONSTRUCTION : refait TOUT le roster
                                         (surnoms, pays, photos) avec la logique
                                         à jour. À lancer une fois après ce script.

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
const FORCE = process.argv.includes('--force');
const SCHEMA = 2;          // version de la logique d'extraction ; --force refait tout ce qui n'est pas à jour
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

function decodeEntities(s){
  return (s||'')
    .replace(/&quot;/gi,'"').replace(/&#0?34;/g,'"')
    .replace(/&#8220;/g,'\u201c').replace(/&#8221;/g,'\u201d')
    .replace(/&#0?39;/g,"'").replace(/&apos;/gi,"'").replace(/&#8217;/g,'\u2019')
    .replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ')
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/\s+/g,' ').trim();
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

/* ─────────────── extraction fiable depuis la page UFC ─────────────── */

// récupère le contenu d'une balise <meta> (surnom + nationalité y vivent, format stable)
function grabMeta(html, key){
  let m = new RegExp('<meta[^>]*'+key+'[^>]*content="([^"]*)"','i').exec(html);
  if(m) return m[1];
  m = new RegExp('<meta[^>]*content="([^"]*)"[^>]*'+key,'i').exec(html);
  return m ? m[1] : '';
}

// gentilé -> nom de pays (aligné sur la table COUNTRY_FLAG d'index.html)
const DEMONYM = {
  'american':'United States','united states':'United States',
  'brazilian':'Brazil','brazil':'Brazil',
  'russian':'Russia','russia':'Russia',
  'canadian':'Canada','canada':'Canada',
  'british':'United Kingdom','english':'England','scottish':'Scotland','welsh':'Wales','irish':'Ireland',
  'australian':'Australia','new zealand':'New Zealand','new zealander':'New Zealand',
  'mexican':'Mexico','ecuadorian':'Ecuador','peruvian':'Peru','chilean':'Chile','argentine':'Argentina','argentinian':'Argentina',
  'polish':'Poland','german':'Germany','french':'France','dutch':'Netherlands','swedish':'Sweden','norwegian':'Norway','spanish':'Spain','italian':'Italy',
  'georgian':'Georgia','armenian':'Armenia','azerbaijani':'Azerbaijan','kazakh':'Kazakhstan','ukrainian':'Ukraine',
  'chinese':'China','japanese':'Japan','korean':'South Korea','south korean':'South Korea','thai':'Thailand','filipino':'Philippines','singaporean':'Singapore',
  'nigerian':'Nigeria','cameroonian':'Cameroon','south african':'South Africa','congolese':'Congo','angolan':'Angola',
  'icelandic':'Iceland','czech':'Czech Republic','slovak':'Slovakia','croatian':'Croatia','serbian':'Serbia',
  'moldovan':'Moldova','belarusian':'Belarus','cuban':'Cuba','jamaican':'Jamaica','dominican':'Dominican Republic','venezuelan':'Venezuela',
  'iranian':'Iran','iraqi':'Iraq','turkish':'Turkey','indian':'India','pakistani':'Pakistan','afghan':'Afghanistan','uzbek':'Uzbekistan','kyrgyz':'Kyrgyzstan','tajik':'Tajikistan',
  'swiss':'Switzerland','austrian':'Austria','belgian':'Belgium','portuguese':'Portugal','greek':'Greece','finnish':'Finland','danish':'Denmark',
  'bulgarian':'Bulgaria','romanian':'Romania','hungarian':'Hungary','lithuanian':'Lithuania','latvian':'Latvia','estonian':'Estonia'
};

const badNick = /division|fighting|active|retired|champion|interim|weight class|debut|not |unknown|n\/a|tba|vacant|title|ranked|contender|roster|athlete/i;
const weightWords = /^(straw|fly|bantam|feather|light|welter|middle|heavy|light heavy|catch)\s*weight$/i;

function validNick(c, first, key){
  if(!c) return null;
  c = c.replace(/\s+/g,' ').trim();
  if(c.length<2 || c.length>26) return null;
  if(/^\d/.test(c)) return null;
  if(badNick.test(c)) return null;
  if(weightWords.test(c)) return null;
  if(deaccent(c)===key || deaccent(c)===first) return null;
  return c;
}

// surnom = premier segment entre guillemets AVANT "is a/an" dans la description
function nickFromDesc(desc, first, key){
  if(!desc) return null;
  const head = desc.split(/\bis\s+an?\b/i)[0];
  const scope = (head && head.length>4) ? head : desc.slice(0,90);
  const m = scope.match(/["\u201c\u00ab]\s*([A-Za-z0-9][A-Za-z0-9 .'\/\-]{0,26}?)\s*["\u201d\u00bb]/);
  return m ? validNick(m[1], first, key) : null;
}

// pays = nationalité ("... is an American professional mixed martial artist ...")
function countryFromDesc(desc){
  if(!desc) return null;
  const m = desc.match(/\bis\s+an?\s+([A-Za-z][A-Za-z \-]{1,24}?)\s+(?:professional|mixed martial|former|current|retired|amateur|fighter|kickboxer|boxer)\b/i);
  if(!m) return null;
  const adj = m[1].toLowerCase().replace(/\s+/g,' ').trim();
  return DEMONYM[adj] || null;
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
  const fileNameOf = u => {
    const dec = decodeURIComponent(u.split('?')[0]);
    const base = dec.substring(dec.lastIndexOf('/')+1);
    return deaccent(base).toLowerCase();
  };
  // le fichier doit contenir le nom de famille OU le prénom : empêche la photo d'un adversaire
  const nameMatches = u => {
    const f = fileNameOf(u);
    return (key.length>2 && f.includes(key)) || (first.length>3 && f.includes(first));
  };
  const mine = list => list.find(nameMatches) || null;

  const heads = all('event_results_athlete_headshot');
  let head = mine(heads);
  if(!head && heads.length===1 && nameMatches(heads[0])) head = heads[0];

  const fulls = all('athlete_bio_full_body');
  let full = mine(fulls);
  if(!full && fulls.length===1 && nameMatches(fulls[0])) full = fulls[0];

  // ── description meta : source fiable du surnom ET de la nationalité ──
  const rawDesc = grabMeta(html,'name="description"')
               || grabMeta(html,'property="og:description"')
               || grabMeta(html,'name="twitter:description"');
  const desc = decodeEntities(rawDesc);

  // ── pays : nationalité depuis la description, sinon repli "Place of Birth" ──
  let country = countryFromDesc(desc);
  if(!country){
    let birth = null;
    let m = html.match(/Place of Birth[^]{0,240}?>\s*([A-Za-z][A-Za-z .,'\/\-]{2,60}?)\s*</i);
    if(m) birth = m[1];
    if(!birth){ m = html.match(/(?:hometown|birthplace)["'>\s:]{1,8}([A-Za-z][A-Za-z .,'\/\-]{2,60}?)\s*</i); if(m) birth = m[1]; }
    if(birth){
      birth = birth.replace(/\s+/g,' ').trim();
      const parts = birth.split(',').map(x=>x.trim()).filter(Boolean);
      let cand = parts.length ? parts[parts.length-1] : birth;
      if(cand && !/\d/.test(cand) && cand.length>=3 && cand.length<=32) country = cand;
    }
  }

  // ── surnom : depuis la description (fiable), sinon anciennes pistes en repli ──
  let nick = nickFromDesc(desc, first, key);
  if(!nick){
    const cands = [];
    const push = re => { let m; const rx=new RegExp(re,'ig'); while((m=rx.exec(html))!==null){ if(m[1]) cands.push(m[1].trim()); } };
    push('field--name-nickname[^>]*>\\s*["\u201c\u201d\']?([A-Za-z][A-Za-z0-9 .\'\\/-]{1,26}?)["\u201c\u201d\']?\\s*<');
    push('hero-profile__nickname[^>]*>\\s*["\u201c\u201d\']?([A-Za-z][A-Za-z0-9 .\'\\/-]{1,26}?)["\u201c\u201d\']?\\s*<');
    push('class=["\'][^"\']*nickname[^"\']*["\'][^>]*>\\s*["\u201c\u201d\']?([A-Za-z][A-Za-z0-9 .\'\\/-]{1,26}?)["\u201c\u201d\']?\\s*<');
    for(const c of cands){ const v = validNick(c, first, key); if(v){ nick = v; break; } }
  }

  if(head || full || country || nick) return { src: head || full || null, head, full, country, nick, source:'ufc' };

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
  if(FORCE) console.log('⚙  MODE FORCE — reconstruction complète du roster\n');

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
    if(e === undefined) return true;                        // jamais tenté
    if(FORCE && (e === null || e.v !== SCHEMA)) return true; // reconstruction : refais tout ce qui n'est pas au nouveau schéma
    if(RETRY && e === null) return true;                    // réessaie les échecs
    return false;
  });

  if(TEST){
    todo = todo.slice(0, 10);
    console.log('\n⚠ MODE TEST — 10 combattants seulement, rien n\'est écrit dans photos.json\n');
  }

  if(!todo.length){
    console.log('\n✓ Rien à faire, tout est déjà résolu.');
    console.log('  (--retry pour réessayer les combattants sans photo, --force pour tout reconstruire)\n');
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
      if(r) r.v = SCHEMA;                          // tampon de version pour que --force soit reprenable
      db[slugKey(n)] = r;
      stats[r ? r.source : 'aucune']++;
      done++;
      if(TEST){
        console.log(`  ${r ? '✓' : '✖'} ${n.padEnd(26)} ${r ? '['+r.source+'] nick='+(r.nick||'—')+' pays='+(r.country||'—') : '— aucune photo trouvée'}`);
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
    console.log('  Si les résultats te vont : node resolve-photos.js --force\n');
  } else {
    console.log(`\n✓ photos.json écrit (${(fs.statSync(OUT).size/1024).toFixed(0)} Ko)`);
    console.log('  Commit-le dans le repo à côté d\'index.html.\n');
  }
})().catch(e=>{
  console.error('\n✖ Erreur fatale :', e.message);
  console.error('  Relance la commande, le script reprend où il s\'est arrêté.\n');
  process.exit(1);
});
