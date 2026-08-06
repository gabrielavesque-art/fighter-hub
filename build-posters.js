/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — affiches officielles de TOUTES les soirées UFC
   ───────────────────────────────────────────────────────────────
   build-events.js ne récupère l'affiche que des cartes à venir. Les
   783 soirées déjà disputées n'en avaient donc aucune, et la grille
   du calendrier affichait des vignettes vides.

   Ce script comble ce trou une fois pour toutes.

   La difficulté n'est pas de lire l'infobox — build-events.js le fait
   déjà — c'est de trouver la BONNE page Wikipedia pour chaque soirée.
   Les noms d'ufcstats et de Wikipedia divergent souvent sur les
   accents (« Medic » vs « Medić ») et la ponctuation, si bien qu'une
   requête sur le nom brut échoue une fois sur trois.

   D'où la méthode : « List of UFC events » liste TOUS les événements
   avec, dans chaque lien, le titre exact de leur page. On lit donc
   d'abord cette page-là, et on en tire des paires
   (nom affiché → titre de page). Plus aucune devinette.

   Incrémental comme resolve-photos.js : une soirée déjà tentée n'est
   pas retentée, sauf --retry (celles restées sans affiche) ou --force
   (tout refaire). Un run complet prend ~15 min à cause de la limite
   de débit Wikimedia ; les suivants quelques secondes.

   Usage :
     node build-posters.js --selftest  → teste l'extraction des liens,
                                         SANS réseau
     node build-posters.js --test      → 12 soirées, verbeux, n'écrit rien
     node build-posters.js             → complète : les jamais tentées
     node build-posters.js --retry     → réessaie aussi celles sans affiche
     node build-posters.js --force     → reconstruction totale

   Produit : posters.json  (à committer à côté d'index.html)
   Aucune dépendance, aucune clé API. Node 18+.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'posters.json');
const UA = 'FighterHub/1.0 (https://github.com/gabrielavesque-art/fighter-hub; projet de fan non commercial) node-fetch';

const SELFTEST = process.argv.includes('--selftest');
const TEST     = process.argv.includes('--test');
const RETRY    = process.argv.includes('--retry');
const FORCE    = process.argv.includes('--force');
const MIN_GAP_MS = 700;      // l'IP des runners GitHub est partagée : on espace
const BATCH = 50;            // maximum de fichiers résolus en un appel

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function wiki(params){
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if(wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&' + params;
  const r = await fetch(url, { headers:{ 'User-Agent':UA, 'Accept':'application/json' } });
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ─────────────── la clé : nom d'affichage → titre de page ─────────────── */
// ATTENTION : ce n'est PAS le slugKey() du site, qui se contente de jeter tout
// ce qui n'est pas [a-z0-9]. Ici on replie d'abord les accents, car Wikipedia
// écrit « Medić » là où ufcstats écrit « Medic » : sans ce repli, les deux
// donneraient « medi » et « medic », et aucune soirée ne serait retrouvée.
// Le site utilise la même fonction sous le nom evPosterKey() — les deux doivent
// rester identiques, sinon posters.json ne se raccroche à rien.
function posterKey(n){
  return String(n || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // « Medić » → « Medic »
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Dans « List of UFC events », chaque ligne porte le lien de sa page :
//   [[UFC 3|UFC 3: The American Dream]]      → page « UFC 3 »
//   {{sort|UFC 003|[[UFC 3|UFC 3: ...]]}}    → idem, enrobé d'un modèle de tri
//   [[UFC Fight Night: Medić vs. Rodriguez]] → page = libellé
// On retient le titre de page ET le libellé affiché : le premier sert à
// interroger Wikipedia, le second à retrouver la soirée côté site.
function parseEventLinks(wt){
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]|[]+?)(?:\|([^\]]+?))?\]\]/g;
  let m;
  while((m = re.exec(wt)) !== null){
    const page = m[1].trim();
    const label = (m[2] || m[1]).trim();
    if(!/^UFC/i.test(page)) continue;                 // que les pages d'événement
    if(/^UFC (Fight Pass|Apex|on |Hall of Fame)/i.test(page)) continue;
    if(seen.has(page)) continue;
    seen.add(page);
    out.push({ page, label });
  }
  return out;
}

// Identique à build-events.js : l'infobox porte le fichier de l'affiche
function posterFile(wt){
  const m = String(wt || '').match(/^\s*\|\s*(?:image|poster)\s*=\s*(?:\[\[)?(?:File|Image)?:?\s*([^\]|\n<]+?)\s*(?:\||\]\]|$)/im);
  if(!m) return '';
  const f = m[1].trim();
  return /\.(jpe?g|png|gif|webp|svg)$/i.test(f) ? f : '';
}

/* ─────────────── résolution des URL, par lots ─────────────── */
async function posterUrls(files){
  const out = new Map();
  for(let i = 0; i < files.length; i += BATCH){
    const lot = files.slice(i, i + BATCH);
    try{
      const j = await wiki('action=query&prop=imageinfo&iiprop=url&iiurlwidth=420&titles='
        + lot.map(f => encodeURIComponent('File:' + f)).join('|'));
      for(const pg of j.query?.pages || []){
        const ii = pg.imageinfo && pg.imageinfo[0];
        if(ii) out.set(pg.title.replace(/^File:/, ''), ii.thumburl || ii.url);
      }
    }catch(e){
      console.warn('  lot d\'affiches ignoré :', e.message);
    }
  }
  return out;
}

/* ─────────────── selftest : sans réseau ─────────────── */
const FIXTURE = `
{| class="wikitable sortable"
|-
! scope="row" | 783
| {{sort|UFC FN 283|[[UFC Fight Night: Medić vs. Rodriguez]]}} || {{dts|2026|Aug|1}}
|-
! scope="row" | 003
| {{sort|UFC 003|[[UFC 3|UFC 3: The American Dream]]}} || {{dts|1994|Sep|9}}
|-
| [[UFC 300|UFC 300: Pereira vs. Hill]] || {{dts|2024|Apr|13}}
|-
| [[Las Vegas]], Nevada || pas un événement
|-
| [[UFC Apex]] || salle, pas un événement
|}`;

function selftest(){
  let ko = 0;
  const check = (label, got, want) => {
    const okk = JSON.stringify(got) === JSON.stringify(want);
    if(!okk) ko++;
    console.log(`${okk ? 'OK  ' : 'ÉCHEC'} ${label}`);
    if(!okk) console.log('   attendu :', JSON.stringify(want), '\n   obtenu  :', JSON.stringify(got));
  };

  const links = parseEventLinks(FIXTURE);
  check('titres de page extraits', links.map(l => l.page),
    ['UFC Fight Night: Medić vs. Rodriguez', 'UFC 3', 'UFC 300']);
  check('libellé affiché conservé', links[1].label, 'UFC 3: The American Dream');
  check('lien sans pipe : page = libellé', links[0].label, 'UFC Fight Night: Medić vs. Rodriguez');
  check('salles et villes écartées', links.some(l => /Apex|Vegas/.test(l.page)), false);

  // le pont entre les deux mondes : l'accent de Wikipedia ne doit pas empêcher
  // de retrouver la soirée nommée « Medic » dans le CSV ufcstats
  check('accents neutralisés par la clé',
    posterKey('UFC Fight Night: Medić vs. Rodriguez'),
    posterKey('UFC Fight Night: Medic vs. Rodriguez'));
  check('clé stable sur la ponctuation',
    posterKey('UFC 300: Pereira vs. Hill'), 'ufc300pereiravshill');

  check('affiche lue dans l\'infobox', posterFile('{{Infobox\n| image = UFC 300 poster.jpg\n}}'), 'UFC 300 poster.jpg');
  check('pas d\'affiche, pas d\'invention', posterFile('{{Infobox\n| venue = [[UFC Apex]]\n}}'), '');

  console.log(ko ? `\n${ko} test(s) en échec.` : '\nTous les tests passent.');
  process.exit(ko ? 1 : 0);
}

/* ─────────────── programme ─────────────── */
(async function main(){
  if(SELFTEST) return selftest();

  let db = {};
  if(!FORCE && fs.existsSync(OUT)){
    try{ db = JSON.parse(fs.readFileSync(OUT, 'utf8')).posters || {}; }
    catch(e){ console.warn('posters.json illisible, on repart de zéro :', e.message); }
  }

  let links = [];
  try{
    const j = await wiki('action=parse&prop=wikitext&redirects=1&page=' + encodeURIComponent('List of UFC events'));
    links = parseEventLinks(j.parse?.wikitext || '');
    console.log(`${links.length} soirée(s) référencée(s) sur Wikipedia.`);
  }catch(e){
    console.error('Liste des événements indisponible :', e.message);
    return;
  }
  if(!links.length){
    console.warn('Aucun lien d\'événement lu : posters.json laissé en l\'état.');
    return;
  }

  // ce qui reste à faire : jamais tenté, ou resté sans affiche si --retry
  let todo = links.filter(l => {
    const k = posterKey(l.label);
    if(FORCE) return true;
    if(!(k in db)) return true;
    return RETRY && !db[k];
  });
  if(TEST) todo = todo.slice(0, 12);
  console.log(`${todo.length} soirée(s) à traiter${TEST ? ' (mode test)' : ''}.`);

  const files = new Map();   // nom de fichier → clés de soirées qui l'utilisent
  let lus = 0;
  for(const l of todo){
    try{
      const j = await wiki('action=parse&prop=wikitext&redirects=1&page=' + encodeURIComponent(l.page));
      const f = posterFile(j.parse?.wikitext || '');
      const k = posterKey(l.label);
      if(f){
        if(!files.has(f)) files.set(f, []);
        files.get(f).push(k);
      } else {
        db[k] = '';            // tenté, sans résultat : on ne réessaiera pas sans --retry
      }
      lus++;
      if(TEST || lus % 50 === 0) console.log(`  ${l.label} → ${f || 'pas d\'affiche'}`);
    }catch(e){
      console.warn(`  ${l.label} — page illisible (${e.message})`);
      db[posterKey(l.label)] = '';
    }
  }

  if(files.size){
    const urls = await posterUrls([...files.keys()]);
    for(const [f, keys] of files){
      const u = urls.get(f) || '';
      for(const k of keys) db[k] = u;
    }
  }

  const avec = Object.values(db).filter(Boolean).length;
  if(TEST){
    console.log(JSON.stringify(db, null, 1));
    console.log(`\n(mode test : rien n'est écrit) ${avec} affiche(s) sur ${Object.keys(db).length} soirée(s).`);
    return;
  }
  if(!avec){
    console.warn('Aucune affiche récupérée : posters.json laissé en l\'état.');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({
    built: new Date().toISOString(),
    source: 'en.wikipedia.org — infobox de chaque page d\'événement',
    posters: db,
  }, null, 1));
  console.log(`posters.json écrit : ${avec} affiche(s) sur ${Object.keys(db).length} soirée(s).`);
})();
