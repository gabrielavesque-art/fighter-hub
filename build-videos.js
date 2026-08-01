/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — association combat ⇄ vidéo YouTube
   ───────────────────────────────────────────────────────────────
   1. construit l'index des 8 800 combats UFC (ufc_fight_results.csv
      + les dates de ufc_event_details.csv)
   2. balaie les uploads des chaînes officielles (UFC, RMC…)
   3. lit « A vs B » dans chaque titre de vidéo, résout les deux noms
      contre l'index, départage les revanches
   4. garde une vidéo par combat : combat complet > highlights

   Produit : videos.json  (petit, à committer à côté d'index.html)

   Usage :
     node build-videos.js --selftest  → hors-ligne (index seul), teste le parseur
     node build-videos.js --test      → n'écrit rien, montre l'échantillon + contrôles
     node build-videos.js             → INCRÉMENTAL : ne relit que les uploads récents
     node build-videos.js --force     → RECONSTRUCTION : rebalaie tout l'historique

   Demande YOUTUBE_API_KEY (secret GitHub). Node 18+, aucune dépendance.

   ─── Pourquoi l'API officielle et pas une recherche par combat ───
   search.list coûte 100 unités de quota par appel, contre 10 000 unités
   gratuites par jour : une recherche par combat = 880 000 unités, soit 88
   jours de quota pour UN run. On prend le problème à l'envers — playlistItems
   .list coûte 1 unité par tranche de 50 vidéos, donc balayer l'intégralité
   d'une chaîne de 50 000 vidéos ne coûte que 1 000 unités. On aspire les
   titres une fois et on fait la jointure nous-mêmes, hors quota.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT      = path.join(__dirname, 'videos.json');
const RESULTS  = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_fight_results.csv';
const EVENTS   = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_event_details.csv';
const UA       = 'FighterHub/1.0 (projet perso non commercial; contact via GitHub)';
const API      = 'https://youtube.googleapis.com/youtube/v3';
const KEY      = process.env.YOUTUBE_API_KEY || '';

const TEST     = process.argv.includes('--test');
const FORCE    = process.argv.includes('--force');
const SELFTEST = process.argv.includes('--selftest');

const SCHEMA   = 1;      // version de la logique de matching
const MAX_PAGES = 1200;  // garde-fou : 1200 × 50 = 60 000 vidéos par chaîne
const OVERLAP_D = 7;     // en incrémental, on repasse 7 jours en arrière (uploads réordonnés)

/* Ordre de préférence des chaînes, à qualité de vidéo égale. La chaîne UFC
   passe devant parce que ses « Free Fight » sont les combats officiels en
   entier ; RMC publie plus souvent des résumés commentés en français.
   Pour privilégier le français : remonter les deux entrées rmc* en tête. */
const CHANNELS = [
  { key:'ufc',    label:'UFC',        handles:['@UFC'],                          q:'UFC' },
  { key:'ufceu',  label:'UFC Europe', handles:['@UFCEurope','@ufceurope'],       q:'UFC Europe' },
  { key:'rmccbt', label:'RMC Sport',  handles:['@RMCSportCombat','@RMCSportMMA'], q:'RMC Sport Combat MMA' },
  { key:'rmc',    label:'RMC Sport',  handles:['@RMCSport'],                     q:'RMC Sport' },
];
const CHAN_PRIO = new Map(CHANNELS.map((c,i)=>[c.key,i]));

/* ═══════════ utilitaires communs aux autres builds ═══════════ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => (v||'').trim();

/* ATTENTION — deux normalisations, et elles ne sont pas interchangeables.

   keySlug est la COPIE EXACTE du slugKey d'index.html. C'est lui qui fabrique
   les clés de videos.json, donc la moindre divergence (ne serait-ce que gérer
   les accents) ferait échouer toutes les recherches côté site. Il supprime
   l'accent avec la lettre : « José » → « jos ».

   lookupSlug sert uniquement à reconnaître un nom DANS un titre YouTube, où
   les accents sont écrits alors que le CSV ufcstats les omet souvent. Il replie
   l'accent sur la lettre : « José » → « jose », comme le CSV « Jose ».
   Les deux formes sont indexées à la lecture, la clé produite reste keySlug. */
function keySlug(n){ return (n||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function lookupSlug(n){
  return (n||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
function col(headers, ...keys){
  const H = headers.map(h=>h.trim().toUpperCase().replace(/[^A-Z]/g,''));
  for(const k of keys){ const K=k.toUpperCase().replace(/[^A-Z]/g,''); const i=H.indexOf(K); if(i>-1) return i; }
  for(const k of keys){ const K=k.toUpperCase().replace(/[^A-Z]/g,''); const i=H.findIndex(h=>h.includes(K)); if(i>-1) return i; }
  return -1;
}
async function getText(url){
  const r = await fetch(url, { headers:{ 'User-Agent':UA }, signal: AbortSignal.timeout(30000) });
  if(!r.ok) throw new Error('HTTP '+r.status+' sur '+url);
  return r.text();
}

/* ═══════════════════════════════════════════════════════════════
   1. INDEX DES COMBATS
   ═══════════════════════════════════════════════════════════════ */

const names  = new Map();   // keySlug -> nom affiché
const byFull = new Map();   // lookupSlug ET keySlug du nom complet -> keySlug canonique
const byLast = new Map();   // lookupSlug du nom de famille -> Set de keySlug
const bouts  = new Map();   // pairKey -> [ {a,b,event,date} ] trié du plus ancien au plus récent

const pairKey = (a,b) => [a,b].sort().join('--');

function indexFighter(name){
  const s = keySlug(name);
  if(!s) return null;
  if(!names.has(s)) names.set(s, name);
  // on indexe les deux orthographes : le titre YouTube écrit « José Aldo » là où
  // le CSV écrit « Jose Aldo », et l'inverse arrive aussi
  byFull.set(s, s);
  byFull.set(lookupSlug(name), s);
  // le nom de famille sert de repêchage quand le titre n'écrit qu'« Gane vs Volkov ».
  // Attention : ça n'est retenu que si le couple résolu tombe sur un vrai combat,
  // sinon « Silva » à lui seul désignerait une douzaine de combattants.
  const w = name.trim().split(/\s+/);
  if(w.length > 1){
    const last = lookupSlug(w[w.length-1]);
    if(last){ if(!byLast.has(last)) byLast.set(last, new Set()); byLast.get(last).add(s); }
  }
  return s;
}

async function buildFightIndex(){
  const [evTxt, resTxt] = await Promise.all([getText(EVENTS), getText(RESULTS)]);

  const evRows = parseCSV(evTxt).filter(r=>r.length>1);
  const evHead = evRows.shift();
  const iEN = col(evHead,'EVENT','NAME'), iED = col(evHead,'DATE');
  const evDate = new Map();
  for(const r of evRows){
    const n = clean(r[iEN]); const t = Date.parse(clean(r[iED]));
    if(n && !isNaN(t)) evDate.set(n, t);
  }

  const rows = parseCSV(resTxt).filter(r=>r.length>1);
  const head = rows.shift();
  const iEvent = col(head,'EVENT'), iBout = col(head,'BOUT');

  let n = 0;
  for(const r of rows){
    const bout = clean(r[iBout]);
    if(!bout) continue;
    const parts = bout.split(/\s+vs\.?\s+/i);
    if(parts.length !== 2) continue;
    const a = indexFighter(clean(parts[0])), b = indexFighter(clean(parts[1]));
    if(!a || !b) continue;
    const event = clean(r[iEvent]);
    const k = pairKey(a,b);
    if(!bouts.has(k)) bouts.set(k, []);
    bouts.get(k).push({ a, b, event, date: evDate.get(event) || 0 });
    n++;
  }
  for(const list of bouts.values()) list.sort((x,y)=>x.date-y.date);
  return { fights:n, pairs:bouts.size, fighters:byFull.size, dated:evDate.size };
}

/* ═══════════════════════════════════════════════════════════════
   2. LECTURE D'UN TITRE DE VIDÉO
   ═══════════════════════════════════════════════════════════════ */

/* Écarté d'office : ces vidéos citent « A vs B » sans montrer le combat.
   Ce filtre passe AVANT le classement, sinon « UFC 300 Countdown: A vs B »
   serait pris pour un combat complet. */
const REJECT = /press ?conf|conf[ée]rence de presse|embedded|countdown|weigh-?in|pes[ée]e|interview|open workout|face-?off|faceoff|pr[ée]diction|preview|analys|r[ée]action|reacts|breakdown|behind the scenes|trash ?talk|best of|top \d|road to|\bep\.? ?\d|\b[ée]pisode|bande-?annonce|trailer|promo|avant-match|d[ée]brief|talk|podcast|\bavis\b|on refait/i;

const FULL = /free fight|full fight|fight in full|le combat complet|combat complet|combat en entier|int[ée]gralit[ée]|en entier/i;
const HL   = /highlight|r[ée]sum[ée]|recap|finish|knock ?out|\bko\b|\btko\b|submission|soumission|best moments|moments forts|temps forts|le combat|meilleurs moments/i;

function classify(title){
  if(REJECT.test(title)) return null;
  if(FULL.test(title)) return 'full';
  if(HL.test(title))   return 'hl';
  return null;
}

/* Découpe autour du premier « vs ». On ne coupe que sur des séparateurs
   entourés d'espaces pour ne pas casser les noms composés (Jean-Silva,
   Ji-Yeon) : un tiret collé aux lettres fait partie du nom. */
const SEP = /\s[|:–—·]\s|\s-\s|[|:()\[\]"«»!?,]|\.\.\./;

/* Un titre contient souvent DEUX « vs » : celui du nom de l'événement et celui
   du combat filmé — « UFC 61: Ortiz vs Shamrock 3 | Free Fight: Rory Singer vs
   Josh Haynes ». Se caler sur le premier rattacherait la vidéo au combat vedette
   au lieu du bon, et les deux étant de vrais combats, rien ne signalerait
   l'erreur. On relève donc TOUTES les occurrences et on tranche plus bas. */
function vsOccurrences(title){
  const re = /\s(?:vs\.?|versus|contre)\s/ig;
  const out = [];
  let m;
  while((m = re.exec(title))){
    const leftParts  = title.slice(0, m.index).split(SEP);
    const rightParts = title.slice(m.index + m[0].length).split(SEP);
    let right = clean(rightParts[0]);
    // « … vs Jiri Prochazka 2 » → 2e opposition entre les deux hommes
    const ord = +((right.match(/\s([2-4])\s*$/) || [])[1] || 0);
    out.push({
      at: m.index,
      left: clean(leftParts[leftParts.length-1]),   // le nom colle au « vs »
      right: right.replace(/\s[2-4]\s*$/,''),
      ord
    });
  }
  return out;
}

/* Position du mot-clé qui a fait classer la vidéo (« Free Fight », « Highlights »,
   « le combat complet »…). C'est lui qui désigne le vrai sujet : le « vs » qui le
   touche est celui du combat filmé, l'autre n'est que l'étiquette de l'événement. */
function keywordPos(title){
  const m = FULL.exec(title) || HL.exec(title);
  return m ? m.index + m[0].length : -1;
}

/* Renvoie les combattants possibles pour un côté du « vs ».
   On teste d'abord les noms complets, du plus long au plus court : le titre
   contient souvent du texte parasite collé au nom (« UFC 300 Free Fight Alex
   Pereira »), et seul le suffixe le plus long qui existe vraiment est le bon. */
function candidates(raw, side){
  const words = clean(raw).split(/\s+/).filter(Boolean);
  if(!words.length) return null;
  const forms = [];
  for(let k = Math.min(4, words.length); k >= 1; k--){
    forms.push(side === 'l' ? words.slice(words.length-k).join(' ') : words.slice(0,k).join(' '));
  }
  for(const f of forms){
    const s = lookupSlug(f);
    if(s && byFull.has(s)) return { slugs:[byFull.get(s)], exact:true };
  }
  for(const f of forms){
    const set = byLast.get(lookupSlug(f));
    if(set) return { slugs:[...set], exact:false };
  }
  return null;
}

/* Le couple doit tomber sur un vrai combat du jeu de données : c'est ce qui
   rend le repêchage par nom de famille sûr. Si plusieurs couples possibles
   ont chacun combattu, le titre est trop ambigu — on préfère ne rien associer
   qu'associer la mauvaise vidéo. */
function matchPair(title){
  const occ = vsOccurrences(title);
  if(!occ.length) return null;
  const kw = keywordPos(title);

  const found = [];
  for(const o of occ){
    const L = candidates(o.left, 'l'), R = candidates(o.right, 'r');
    if(!L || !R) continue;
    const hits = new Set();
    for(const a of L.slugs) for(const b of R.slugs){
      if(a === b) continue;
      const k = pairKey(a,b);
      if(bouts.has(k)) hits.add(k);
    }
    if(hits.size !== 1) continue;   // couple ambigu : on préfère ne rien associer
    found.push({ key:[...hits][0], ord:o.ord, dist: kw < 0 ? 0 : Math.abs(o.at - kw) });
  }
  if(!found.length) return null;

  const keys = new Set(found.map(f=>f.key));
  if(keys.size > 1){
    // deux vrais combats cités : celui collé au mot-clé est le sujet de la vidéo
    found.sort((a,b)=>a.dist-b.dist);
    if(found[0].dist === found[1].dist) return null;   // à égalité, on s'abstient
    const win = found[0].key;
    return { key:win, ord: Math.max(...found.filter(f=>f.key===win).map(f=>f.ord)) };
  }
  return { key: found[0].key, ord: Math.max(...found.map(f=>f.ord)) };
}

/* Départage les revanches. Le numéro d'événement écrit dans le titre est le
   signal le plus fiable ; ensuite l'ordinal (« Prochazka 2 ») ; en dernier
   recours la date de mise en ligne, qui suit toujours le combat. */
function pickBout(list, title, publishedAt){
  if(list.length === 1) return list[0];

  const num = (title.match(/\bUFC\s+(\d{1,4})\b/i) || [])[1];
  if(num){
    const hit = list.filter(b => new RegExp('^UFC\\s+'+num+'\\b','i').test(b.event));
    if(hit.length === 1) return hit[0];
  }
  const ord = (title.match(/\s([2-4])\s*(?:$|[|:–—])/) || [])[1];
  if(ord && list[+ord-1]) return list[+ord-1];

  const pub = Date.parse(publishedAt) || 0;
  if(pub){
    const past = list.filter(b => b.date && b.date <= pub);
    const pool = past.length ? past : list.filter(b=>b.date);
    if(pool.length) return pool.reduce((best,b) => Math.abs(b.date-pub) < Math.abs(best.date-pub) ? b : best);
  }
  return null;   // revanche indépartageable : on n'associe rien
}

/* Clé de sortie, relue telle quelle par index.html : le couple seul quand les
   deux hommes ne se sont affrontés qu'une fois (le cas de plus de 95 % des
   combats), le couple + la date sinon. */
function outKey(pk, bout, list){
  if(list.length === 1) return pk;
  return pk + '@' + (bout.date ? new Date(bout.date).toISOString().slice(0,10) : bout.event.slice(0,24));
}

/* ═══════════════════════════════════════════════════════════════
   3. API YOUTUBE
   ═══════════════════════════════════════════════════════════════ */

let quota = 0;

async function api(endpoint, params, cost){
  const url = new URL(API + endpoint);
  for(const [k,v] of Object.entries(params)) if(v != null) url.searchParams.set(k, v);
  url.searchParams.set('key', KEY);

  for(let attempt = 0; ; attempt++){
    const r = await fetch(url, { headers:{ 'Accept':'application/json' }, signal: AbortSignal.timeout(20000) });
    if(r.ok){ quota += cost; return r.json(); }

    const body = await r.text();
    // 403 quotaExceeded n'est pas une erreur passagère : réessayer ne fait
    // que brûler du temps, le quota ne revient qu'à minuit heure du Pacifique.
    if(r.status === 403 && /quotaExceeded/.test(body)) throw new Error('QUOTA YouTube épuisé (10 000 unités/jour). Relancer demain.');
    if(r.status === 403) throw new Error('403 YouTube — clé invalide ou API non activée : '+body.slice(0,200));
    if(attempt >= 2) throw new Error('HTTP '+r.status+' '+body.slice(0,200));
    await sleep(1000 * (attempt+1));
  }
}

async function resolveChannel(cfg){
  for(const h of cfg.handles){
    const j = await api('/channels', { part:'contentDetails,snippet', forHandle:h }, 1);
    const it = (j.items||[])[0];
    if(it) return { id:it.id, title:it.snippet.title, uploads:it.contentDetails.relatedPlaylists.uploads, via:h };
  }
  // repli : recherche par nom (100 unités, seulement si le handle a changé)
  const s = await api('/search', { part:'snippet', type:'channel', q:cfg.q, maxResults:1 }, 100);
  const hit = (s.items||[])[0];
  if(!hit) return null;
  const id = hit.id.channelId;
  const j = await api('/channels', { part:'contentDetails,snippet', id }, 1);
  const it = (j.items||[])[0];
  if(!it) return null;
  return { id:it.id, title:it.snippet.title, uploads:it.contentDetails.relatedPlaylists.uploads, via:'recherche « '+cfg.q+' »' };
}

/* La playlist « uploads » d'une chaîne est rendue de la plus récente à la plus
   ancienne : en incrémental on s'arrête dès qu'on retombe sur du déjà-vu, ce
   qui ramène un run quotidien à quelques unités de quota au lieu de ~1 500. */
async function sweep(uploads, since){
  const out = [];
  let pageToken = null, pages = 0, stop = false;
  do {
    const j = await api('/playlistItems', { part:'snippet', playlistId:uploads, maxResults:50, pageToken }, 1);
    for(const it of (j.items||[])){
      const sn = it.snippet || {};
      const id = sn.resourceId && sn.resourceId.videoId;
      if(!id || !sn.title) continue;
      if(since && sn.publishedAt < since){ stop = true; continue; }
      out.push({ id, title: sn.title, publishedAt: sn.publishedAt || '' });
    }
    pageToken = j.nextPageToken;
    pages++;
  } while(pageToken && !stop && pages < MAX_PAGES);
  return { videos: out, pages, truncated: !!pageToken && pages >= MAX_PAGES };
}

/* ═══════════════════════════════════════════════════════════════
   4. RUN
   ═══════════════════════════════════════════════════════════════ */

const score = v => (v.k === 'full' ? 100 : 50) - CHAN_PRIO.get(v.c);

function readPrevious(){
  if(FORCE || !fs.existsSync(OUT)) return { _meta:{ channels:{} }, v:{} };
  try{
    const j = JSON.parse(fs.readFileSync(OUT,'utf8'));
    if((j._meta||{}).schema !== SCHEMA) return { _meta:{ channels:{} }, v:{} };   // logique changée -> on repart de zéro
    return { _meta:j._meta, v:j.v||{} };
  }catch{ return { _meta:{ channels:{} }, v:{} }; }
}

async function main(){
  console.log('\n── Index des combats ──');
  const idx = await buildFightIndex();
  console.log(`  ${idx.fights} combats · ${idx.pairs} oppositions · ${idx.fighters} combattants · ${idx.dated} événements datés`);

  if(SELFTEST) return selftest();

  if(!KEY){
    console.error('\n✗ YOUTUBE_API_KEY absent. Ajouter le secret GitHub du même nom.\n');
    process.exit(1);
  }

  const prev = readPrevious();
  const merged = { ...prev.v };
  const meta = { schema:SCHEMA, built:new Date().toISOString(), channels:{} };
  const seenTitles = [];
  let scanned = 0, classified = 0, matched = 0, unmatched = [];

  for(const cfg of CHANNELS){
    console.log(`\n── ${cfg.label} (${cfg.key}) ──`);
    // une chaîne qui échoue ne doit pas perdre son repère incrémental, sinon le
    // run suivant rebalaie ses 50 000 vidéos pour rien
    const keep = () => { const p = (prev._meta.channels||{})[cfg.key]; if(p) meta.channels[cfg.key] = p; };

    let ch;
    try{ ch = await resolveChannel(cfg); }
    catch(e){ console.error('  ✗ résolution impossible :', e.message); keep(); continue; }
    if(!ch){ console.error('  ✗ chaîne introuvable — vérifier le handle dans CHANNELS'); keep(); continue; }
    console.log(`  chaîne : « ${ch.title} » (${ch.id}) via ${ch.via}`);

    const prevCh = (prev._meta.channels||{})[cfg.key] || {};
    let since = null;
    if(!FORCE && prevCh.newest){
      const d = new Date(Date.parse(prevCh.newest) - OVERLAP_D*86400000);
      since = d.toISOString();
      console.log(`  incrémental depuis ${since.slice(0,10)}`);
    }

    let res;
    try{ res = await sweep(ch.uploads, since); }
    catch(e){ console.error('  ✗ balayage interrompu :', e.message); keep(); continue; }
    if(res.truncated) console.warn(`  ! plafond de ${MAX_PAGES} pages atteint — chaîne non balayée en entier`);

    let chMatched = 0;
    let newest = prevCh.newest || '';
    for(const v of res.videos){
      scanned++;
      if(v.publishedAt > newest) newest = v.publishedAt;
      const kind = classify(v.title);
      if(!kind) continue;
      classified++;
      const hit = matchPair(v.title);
      if(!hit){ if(unmatched.length < 40) unmatched.push(v.title); continue; }
      const list = bouts.get(hit.key);
      const bout = hit.ord && list[hit.ord-1] ? list[hit.ord-1] : pickBout(list, v.title, v.publishedAt);
      if(!bout) continue;

      const key = outKey(hit.key, bout, list);
      const cand = { i:v.id, t:v.title, c:cfg.key, k:kind };
      const cur = merged[key];
      if(!cur || score(cand) > score(cur)){ merged[key] = cand; }
      matched++; chMatched++;
      if(seenTitles.length < 12) seenTitles.push(`${kind==='full'?'complet ':'résumé '} ${v.title}`);
    }

    meta.channels[cfg.key] = { id:ch.id, title:ch.title, newest, scanned:res.videos.length, matched:chMatched };
    console.log(`  ${res.videos.length} vidéos lues (${res.pages} pages) · ${chMatched} rattachées à un combat`);
  }

  const covered = Object.keys(merged).length;
  meta.stats = { fights: idx.fights, covered, scanned, classified, quota };

  console.log('\n── Bilan ──');
  console.log(`  ${scanned} vidéos lues · ${classified} identifiées comme combat/résumé · ${matched} rattachements`);
  console.log(`  ${covered} combats couverts sur ${idx.fights} (${(covered/idx.fights*100).toFixed(1)} %)`);
  console.log(`  quota consommé : ${quota} unités sur 10 000/jour`);

  if(seenTitles.length){
    console.log('\n  Échantillon :');
    for(const t of seenTitles) console.log('   ·', t);
  }
  if(unmatched.length){
    console.log('\n  Titres classés « combat » mais non rattachés (à surveiller) :');
    for(const t of unmatched.slice(0,15)) console.log('   ·', t);
  }

  if(TEST){ console.log('\n(--test : rien écrit)\n'); return; }
  fs.writeFileSync(OUT, JSON.stringify({ _meta:meta, v:merged }));
  console.log(`\n✓ videos.json écrit (${(fs.statSync(OUT).size/1024).toFixed(0)} Ko)\n`);
}

/* ═══════════════════════════════════════════════════════════════
   5. SELFTEST — vérifie le parseur sans toucher à YouTube
   ═══════════════════════════════════════════════════════════════ */

// [ titre, type attendu ('full'/'hl'/null), un des deux noms attendus (ou null) ]
const FIXTURES = [
  ['Free Fight: Conor McGregor vs Eddie Alvarez | UFC 205',            'full', 'conormcgregor'],
  ['UFC 300 Free Fight: Alex Pereira vs Jamahal Hill',                 'full', 'alexpereira'],
  ['Israel Adesanya vs Alex Pereira 2 | UFC 287 Free Fight',           'full', 'israeladesanya'],
  ['UFC 229: Khabib Nurmagomedov vs Conor McGregor - Fight Highlights','hl',   'khabibnurmagomedov'],
  ['Fight Highlights | Islam Makhachev vs Dustin Poirier',             'hl',   'islammakhachev'],
  ['Le combat complet : Ciryl Gane vs Tai Tuivasa',                    'full', 'cirylgane'],
  ['MMA - UFC : le résumé de Gane vs Volkov',                          'hl',   'cirylgane'],
  ['Jon Jones vs. Stipe Miocic | UFC 309 Highlights',                  'hl',   'jonjones'],
  // le nom de l'événement contient un « vs » : c'est le combat collé au mot-clé
  // qui compte, pas le combat vedette de l'affiche
  ['UFC 61: Ortiz vs Shamrock 2 | Free Fight: Joe Stevenson vs Yves Edwards','full','joestevenson'],
  ['UFC 205: Alvarez vs McGregor | Free Fight: Yoel Romero vs Chris Weidman','full','yoelromero'],
  ['UFC 300 Countdown: Pereira vs Hill',                               null,   null],
  ['Alex Pereira vs Jamahal Hill Press Conference Highlights',         null,   null],
  ['UFC 281 Embedded: Vlog Series - Episode 1',                        null,   null],
  ['Dustin Poirier Octagon Interview | UFC 291',                       null,   null],
];

function selftest(){
  console.log('\n── Selftest du parseur ──');
  let ok = 0, ko = 0;
  for(const [title, wantKind, wantSlug] of FIXTURES){
    const kind = classify(title);
    let slugOk = wantSlug === null, key = null;
    if(kind){
      const hit = matchPair(title);
      key = hit && hit.key;
      if(wantSlug) slugOk = !!key && key.split('--').includes(wantSlug);
      else slugOk = true;
    }
    const pass = kind === wantKind && slugOk;
    pass ? ok++ : ko++;
    console.log(`  ${pass?'✓':'✗'} [${String(kind)}] ${title}`);
    if(!pass) console.log(`      attendu ${wantKind} / ${wantSlug} — obtenu ${kind} / ${key}`);
  }

  // contrôle de robustesse : une revanche doit produire deux clés distinctes
  const rem = [...bouts.entries()].find(([,l]) => l.length >= 3);
  if(rem){
    const [pk, list] = rem;
    console.log(`\n  Revanche témoin : ${names.get(list[0].a)} vs ${names.get(list[0].b)} (${list.length} combats)`);
    for(const b of list) console.log('   ·', outKey(pk, b, list), '→', b.event.trim());
  }

  console.log(`\n  ${ok} ok · ${ko} ko\n`);
  if(ko) process.exit(1);
}

main().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
