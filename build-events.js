/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — cartes UFC à venir
   ───────────────────────────────────────────────────────────────
   Le CSV ufcstats ne contient QUE des combats déjà disputés : il ne
   sait rien des affiches annoncées. Ce script comble ce trou pour
   la section « Pronos » — sans lui, il faut composer ses affiches
   à la main (ce qui reste possible, et le site fonctionne sans
   events.json : il est purement optionnel).

   Source : Wikipedia anglais, en wikitext (action=parse&prop=wikitext)
   plutôt qu'en HTML. Le wikitext bouge beaucoup moins que le rendu,
   et c'est déjà la source de build-descriptions.js.

     1. « List of UFC events » → tableau des événements programmés
        (nom, date, salle, ville).
     2. la page de chaque événement → les combats annoncés, lus dans
        les deux formes qu'on rencontre : la liste à puces
        « Announced bouts » et le tableau de carte.

   Règle d'or, comme ailleurs dans le projet : mieux vaut pas de
   fichier qu'un mauvais fichier. Si la lecture ne donne rien, on
   garde events.json tel quel plutôt que de l'écraser avec du vide.

   Un fichier events-manual.json (même schéma) est fusionné par-dessus
   et gagne toujours : c'est le rattrapage quand Wikipedia change de
   forme ou tarde à publier une carte.

   Usage :
     node build-events.js --selftest   → teste les parseurs sur des
                                         fixtures, SANS réseau. À lancer
                                         avant tout changement de regex.
     node build-events.js --test       → lit Wikipedia, affiche, n'écrit rien
     node build-events.js              → écrit events.json

   Produit : events.json  (à committer à côté d'index.html)
   Aucune dépendance, aucune clé API. Node 18+.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'events.json');
const MANUAL = path.join(__dirname, 'events-manual.json');
// même politique que build-descriptions.js : Wikimedia bride les UA génériques
const UA = 'FighterHub/1.0 (https://github.com/gabrielavesque-art/fighter-hub; projet de fan non commercial) node-fetch';

const SELFTEST = process.argv.includes('--selftest');
const TEST     = process.argv.includes('--test');
const MAX_EVENTS = 4;        // deux mois de cartes suffisent à un pronostiqueur
const MIN_GAP_MS = 700;      // l'IP des runners GitHub est partagée : on espace

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function wikitext(page, section){
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if(wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2'
    + '&prop=wikitext&redirects=1&page=' + encodeURIComponent(page)
    + (section != null ? '&section=' + section : '');
  const r = await fetch(url, { headers:{ 'User-Agent':UA, 'Accept':'application/json' } });
  if(!r.ok) throw new Error(`${page} → HTTP ${r.status}`);
  const j = await r.json();
  if(j.error) throw new Error(`${page} → ${j.error.info}`);
  return j.parse?.wikitext || '';
}

/* ─────────────── nettoyage wikitext ─────────────── */
// [[Jon Jones|Jones]] → Jones ; [[Jon Jones]] → Jon Jones ; {{flagicon|USA}} → rien
function plain(s){
  return String(s || '')
    .replace(/\{\{[^{}]*\}\}/g, ' ')            // modèles : flagicon, dts, sortname…
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<ref[^>]*\/>/gi, ' ')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// « (c) », « (ic) » : les marqueurs de champion collés au nom sur Wikipedia
function cleanName(s){
  return plain(s)
    .replace(/\((?:c|ic|C|IC)\)\s*$/, '')
    .replace(/^[\s·—–-]+|[\s·—–-]+$/g, '')
    .trim();
}
// « Light Heavyweight » AVANT « Heavyweight » : le motif du second est contenu
// dans le premier, l'ordre de cette liste est donc la règle de priorité.
const DIVISIONS = ['Light Heavyweight','Heavyweight','Middleweight','Welterweight','Lightweight',
                   'Featherweight','Bantamweight','Flyweight','Strawweight'];
function divOf(line){
  const women = /women/i.test(line);
  for(const d of DIVISIONS){
    if(new RegExp(d.replace(' ', '\\s+'), 'i').test(line)){
      return women && d !== 'Heavyweight' && d !== 'Light Heavyweight' ? "Women's " + d : d;
    }
  }
  if(/catchweight/i.test(line)) return 'Catchweight';
  return '';
}
const isTitle = line => /championship|title/i.test(line);

/* ─────────────── 1. les événements programmés ─────────────── */
// Le tableau « Scheduled events » : une ligne par événement, les colonnes
// varient (avec ou sans numéro), donc on lit le nom, la date et le lieu par
// leur forme et pas par leur position.
function parseScheduled(wt){
  const out = [];
  const block = wt.split(/\n\|-/);
  for(const row of block){
    if(!/UFC/.test(row)) continue;
    const cells = row.split(/\n?\|\||\n\|/).map(c=>c.trim()).filter(Boolean);
    if(cells.length < 2) continue;
    let name = '', date = '';
    const place = [];      // salle puis ville : les deux intéressent le lecteur
    for(const c of cells){
      const dts = c.match(/\{\{\s*dts\s*\|([^}]+)\}\}/i);
      if(!date && dts){
        const parts = dts[1].split('|').map(s=>s.trim()).filter(s=>!/^format/i.test(s));
        const iso = parts.join('-').replace(/[^0-9-]/g, '');
        if(/^\d{4}-\d{1,2}-\d{1,2}$/.test(iso)){
          const [y,m,d] = iso.split('-');
          date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
        }
        continue;
      }
      if(!date){
        const txt = plain(c);
        const md = txt.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/);
        if(md){
          const t = Date.parse(`${md[1]} ${md[2]}, ${md[3]} UTC`);
          if(!isNaN(t)) { date = new Date(t).toISOString().slice(0,10); continue; }
        }
      }
      const txt = plain(c);
      if(!name && /^UFC\b/.test(txt)) { name = txt; continue; }
      if(name && date && txt && !/^\d+$/.test(txt)) place.push(txt);
    }
    if(name && date) out.push({ name, date, location: place.join(', ') });
  }
  // une carte annoncée est forcément dans le futur ; on trie du plus proche au
  // plus lointain pour que « la prochaine » soit vraiment la prochaine
  const today = new Date().toISOString().slice(0,10);
  return out.filter(e=>e.date >= today).sort((a,b)=>a.date.localeCompare(b.date));
}

/* ─────────────── 2. les combats d'une carte ─────────────── */
// Deux formes cohabitent sur les pages d'événements à venir :
//   · la liste à puces  «*Heavyweight bout: [[A]] vs. [[B]]»
//   · le tableau de carte «| Heavyweight || [[A]] || vs. || [[B]] ||»
// On lit les deux et on dédoublonne : une même affiche peut figurer aux deux
// endroits quand la page est en cours de mise à jour.
function parseBouts(wt){
  const seen = new Set(), out = [];
  const push = (a, b, line, card) => {
    a = cleanName(a); b = cleanName(b);
    if(!a || !b || a.length > 42 || b.length > 42) return;
    if(!/[a-zA-Z]{2}/.test(a) || !/[a-zA-Z]{2}/.test(b)) return;
    const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
    if(seen.has(key)) return;
    seen.add(key);
    const title = isTitle(line);
    out.push({ a, b, wc: divOf(line), title, rounds: title ? 5 : 3, card });
  };

  let card = '';
  for(const raw of wt.split('\n')){
    const line = raw.trim();
    if(/^==+\s*(main card|preliminary|early prelim|announced bouts|fight card)/i.test(line)
       || /^!\s*colspan.*\|\s*(main card|preliminary|early prelim)/i.test(line)){
      card = /early/i.test(line) ? 'early' : /prelim/i.test(line) ? 'prelim' : 'main';
    }
    if(!/\bvs\.?\b/i.test(line)) continue;

    // forme tableau : les cellules sont séparées par ||
    if(/^\|/.test(line) && line.includes('||')){
      const cells = line.replace(/^\|/, '').split('||').map(c=>c.trim());
      const i = cells.findIndex(c=>/^vs\.?$/i.test(plain(c)));
      if(i > 0 && cells[i+1]){ push(cells[i-1], cells[i+1], line, card); continue; }
    }
    // forme liste à puces : « Division bout: A vs. B »
    if(/^\*/.test(line)){
      const body = line.replace(/^\*+\s*/, '');
      const after = body.includes(':') ? body.slice(body.indexOf(':')+1) : body;
      const m = after.split(/\s+vs\.?\s+/i);
      if(m.length === 2) push(m[0], m[1], line, card || 'main');
    }
  }
  return out;
}

/* ─────────────── selftest : les parseurs, sans réseau ─────────────── */
const FIXTURES = {
  scheduled: `
{| class="wikitable"
! # !! Event !! Date !! Venue !! City
|-
| 726 || [[UFC 321]] || {{dts|2099-10-25}} || [[Etihad Arena]] || {{flagicon|UAE}} [[Abu Dhabi]], UAE
|-
| 727 || [[UFC Fight Night: Smith vs. Jones]] || {{dts|2099-11-08}} || [[UFC Apex]] || {{flagicon|USA}} [[Las Vegas]], Nevada, US
|-
| 700 || [[UFC 300]] || {{dts|2020-01-01}} || [[T-Mobile Arena]] || {{flagicon|USA}} [[Las Vegas]], US
|}`,
  bouts: `
==Fight card==
{| class="toccolours"
! colspan=8 | Main card
|-
| Heavyweight || {{flagicon|GBR}} [[Tom Aspinall]] (c) || vs. || {{flagicon|USA}} [[Jon Jones]] || For the [[UFC Heavyweight Championship]]
|-
| Women's Flyweight || {{flagicon|KGZ}} [[Valentina Shevchenko]] || vs. || {{flagicon|BRA}} [[Manon Fiorot]] ||
|-
! colspan=8 | Preliminary card
|-
| Light Heavyweight || [[Carlos Ulberg]] || vs. || [[Magomed Ankalaev]] ||
|}

===Announced bouts===
*Lightweight bout: [[Islam Makhachev]] vs. [[Justin Gaethje]]
*Women's Bantamweight bout: [[Kayla Harrison]] vs. [[Amanda Nunes]]
*Heavyweight bout: [[Tom Aspinall]] vs. [[Jon Jones]]
`,
};
function selftest(){
  let ko = 0;
  const check = (label, got, want) => {
    const okk = JSON.stringify(got) === JSON.stringify(want);
    if(!okk) ko++;
    console.log(`${okk ? 'OK  ' : 'ÉCHEC'} ${label}`);
    if(!okk) console.log('   attendu :', JSON.stringify(want), '\n   obtenu  :', JSON.stringify(got));
  };

  const sched = parseScheduled(FIXTURES.scheduled);
  check('événements programmés : noms', sched.map(e=>e.name), ['UFC 321','UFC Fight Night: Smith vs. Jones']);
  check('événements programmés : dates', sched.map(e=>e.date), ['2099-10-25','2099-11-08']);
  check('les événements passés sont écartés', sched.some(e=>e.name==='UFC 300'), false);
  check('lieu lu', /Abu Dhabi/.test(sched[0].location), true);

  const bouts = parseBouts(FIXTURES.bouts);
  check('affiches dédoublonnées', bouts.length, 5);
  check('tableau : noms sans (c) ni drapeau', [bouts[0].a, bouts[0].b], ['Tom Aspinall','Jon Jones']);
  check('combat de titre détecté', [bouts[0].title, bouts[0].rounds], [true, 5]);
  check('division féminine', bouts[1].wc, "Women's Flyweight");
  check('mi-lourds pas confondus avec lourds', bouts[2].wc, 'Light Heavyweight');
  check('carte préliminaire repérée', bouts[2].card, 'prelim');
  check('liste à puces lue', [bouts[3].a, bouts[3].b, bouts[3].wc], ['Islam Makhachev','Justin Gaethje','Lightweight']);
  check('doublon liste/tableau ignoré', bouts.filter(b=>b.a==='Tom Aspinall').length, 1);

  console.log(ko ? `\n${ko} test(s) en échec.` : '\nTous les tests passent.');
  process.exit(ko ? 1 : 0);
}

/* ─────────────── fusion du rattrapage manuel ─────────────── */
function mergeManual(events){
  if(!fs.existsSync(MANUAL)) return events;
  let manual;
  try{ manual = JSON.parse(fs.readFileSync(MANUAL, 'utf8')); }
  catch(e){ console.warn('events-manual.json illisible :', e.message); return events; }
  const list = Array.isArray(manual) ? manual : (manual.events || []);
  const by = new Map(events.map(e=>[e.name.toLowerCase(), e]));
  for(const e of list){
    if(!e || !e.name) continue;
    by.set(e.name.toLowerCase(), e);        // la saisie manuelle gagne toujours
  }
  return [...by.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}

/* ─────────────── programme ─────────────── */
(async function main(){
  if(SELFTEST) return selftest();

  let events = [];
  try{
    // la section « Scheduled events » est en tête de l'article ; on prend tout
    // le wikitext et on isole le tableau qui suit ce titre
    const wt = await wikitext('List of UFC events');
    const i = wt.search(/==\s*Scheduled events\s*==/i);
    const chunk = i > -1 ? wt.slice(i, wt.indexOf('\n==', i + 5)) : wt;
    events = parseScheduled(chunk).slice(0, MAX_EVENTS);
    console.log(`${events.length} événement(s) programmé(s).`);
  }catch(e){
    console.error('Liste des événements indisponible :', e.message);
  }

  for(const ev of events){
    try{
      ev.bouts = parseBouts(await wikitext(ev.name));
      console.log(`  ${ev.name} (${ev.date}) — ${ev.bouts.length} affiche(s)`);
    }catch(e){
      ev.bouts = [];
      console.warn(`  ${ev.name} — page illisible : ${e.message}`);
    }
  }
  events = events.filter(e=>e.bouts && e.bouts.length);
  events = mergeManual(events);

  if(TEST){
    console.log(JSON.stringify({ events }, null, 2));
    return;
  }
  if(!events.length){
    // mieux vaut la carte d'hier que pas de carte du tout
    console.warn('Aucune carte exploitable : events.json laissé en l\'état.');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({
    built: new Date().toISOString(),
    source: 'en.wikipedia.org — List of UFC events',
    events,
  }, null, 1));
  console.log(`events.json écrit : ${events.length} carte(s), ${events.reduce((n,e)=>n+e.bouts.length,0)} affiche(s).`);
})();
