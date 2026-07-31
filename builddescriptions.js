/* ═══════════════════════════════════════════════════════════════
   FIGHTER HUB — descriptions humaines des combattants
   ───────────────────────────────────────────────────────────────
   Objectif : une note courte (2-3 phrases) qui donne envie de
   s'attacher au combattant — d'où il vient, ce qu'il a traversé,
   comment il est arrivé là. PAS un résumé de palmarès : l'ELO, les
   stats et l'historique sont déjà affichés juste à côté dans la modale.

   Deux chemins, dans cet ordre :
     1. fr.wikipedia — on sélectionne les vraies phrases françaises
        des sections « Jeunesse / Biographie / Vie personnelle », en
        les notant avec un lexique d'intérêt humain.
     2. en.wikipedia — pas de page FR : on extrait des FAITS de la
        page anglaise (naissance, galères, âge de début, discipline
        d'origine, ancien métier…) et on recompose 2 phrases en
        français à partir de gabarits. Jamais de traduction mot à mot.

   Règle d'or : mieux vaut aucune description qu'une mauvaise.
   Sous le seuil de confiance, on renvoie null.

   Usage :
     node build-descriptions.js --test        → 12 combattants, verbeux, n'écrit rien
     node build-descriptions.js --only="Islam Makhachev,Alex Pereira"
                                              → cible des noms précis, verbeux, n'écrit rien
     node build-descriptions.js               → complète : traite ceux jamais tentés
     node build-descriptions.js --retry       → réessaie aussi ceux restés sans description
     node build-descriptions.js --force       → RECONSTRUCTION : refait tout le roster

   Produit : descriptions.json  (à committer à côté d'index.html)

   Aucune dépendance, aucune clé API. Node 18+.
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const OUT  = path.join(__dirname, 'descriptions.json');
const TOTT = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/ufc_fighter_tott.csv';
const UA   = 'FighterHub/1.0 (projet perso non commercial; contact via GitHub)';

const TEST   = process.argv.includes('--test');
const RETRY  = process.argv.includes('--retry');
const FORCE  = process.argv.includes('--force');
const ONLY   = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7)
                 .split(',').map(s => s.trim()).filter(Boolean);
const DRY    = TEST || ONLY.length > 0;   // les deux modes d'essai n'écrivent rien

const SCHEMA      = 1;    // version de la logique ; --force refait tout ce qui n'est pas à jour
const CONCURRENCY = 3;    // requêtes en parallèle — rester poli avec Wikipedia
const PAUSE_MS    = 150;
const MAX_CHARS   = 300;  // longueur visée de la description finale
const MIN_SCORE   = 4;    // en dessous, la phrase n'apporte rien d'humain

/* ─────────────── utilitaires ─────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function slugKey(n){ return (n||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

function deaccent(x){
  return (x||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/ł/gi,'l').replace(/ø/gi,'o').replace(/đ/gi,'d')
    .replace(/æ/gi,'ae').replace(/œ/gi,'oe').replace(/ß/g,'ss')
    .replace(/ı/gi,'i').replace(/þ/gi,'th')
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

async function get(url){
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.text();
}
const getJSON = async url => JSON.parse(await get(url));

/* ═══════════════════════════════════════════════════════════════
   1. TROUVER LA BONNE PAGE WIKIPEDIA
   ═══════════════════════════════════════════════════════════════ */

const PARTICLES = new Set(['Dos','Das','Da','Do','De','Del','Della','Di','Van','Von','Der','Den','Du','La','Le','Ter','Bin','Al','St','Mc']);

const MMA_EN = /mixed martial|martial artist|\bufc\b|\bmma\b|kickbox|\bfighter\b|\bboxer\b|grappler|wrestler|jiu-?jitsu|bellator|octagon|welterweight|middleweight|heavyweight|lightweight|bantamweight|featherweight|flyweight|strawweight/i;
const MMA_FR = /arts martiaux mixtes|\bufc\b|\bmma\b|kickboxeur|kick-boxeur|combattant|pratiquant de|boxeur|lutteur|grappling|jiu-?jitsu|judoka|sambiste|poids (?:paille|mouche|coq|plume|l[ée]gers?|welters?|moyens?|mi-lourds?|lourds?)/i;
const DISAMBIG = /\bmay refer to\b|\bcan refer to\b|refer to\s*:|homonymie|peut (?:faire r[ée]f[ée]rence|d[ée]signer)/i;

function titleVariants(name, lang){
  const out = [name];
  const w = name.split(' ');
  const low = w.map((x,i) => i>0 && PARTICLES.has(x) ? x.toLowerCase() : x).join(' ');
  if(low !== name) out.push(low);
  if(lang === 'fr'){
    out.push(name+' (combattant)');
    out.push(name+' (arts martiaux mixtes)');
  } else {
    out.push(name+' (fighter)');
    out.push(name+' (mixed martial artist)');
  }
  return out;
}

function isFighterPage(title, extract, lang){
  const ex = extract || '';
  if(DISAMBIG.test(ex)) return false;
  if(/\((fighter|mixed martial artist|martial artist|mma fighter|combattant)\)/i.test(title||'')) return true;
  return (lang === 'fr' ? MMA_FR : MMA_EN).test(ex);
}

// 1 requête : intro courte sur toutes les variantes d'un coup, pour désigner le bon titre
async function findTitle(name, lang){
  const variants = titleVariants(name, lang);
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2`
            + '&redirects=1&prop=extracts&exintro=1&explaintext=1&exsentences=4&exlimit=20'
            + '&titles=' + encodeURIComponent(variants.join('|'));
  let pages;
  try { pages = (await getJSON(url)).query?.pages || []; } catch(e){ return null; }

  const last = deaccent(name.trim().split(/\s+/).pop());
  const ok = pages.filter(p => !p.missing && p.extract
                            && isFighterPage(p.title, p.extract, lang)
                            && (last.length <= 2 || deaccent(p.title).includes(last)));
  if(!ok.length) return null;
  // on respecte l'ordre des variantes : le titre nu passe avant les formes désambiguïsées
  const rank = t => { const i = variants.findIndex(v => deaccent(v) === deaccent(t)); return i < 0 ? 99 : i; };
  ok.sort((a,b) => rank(a.title) - rank(b.title));
  return ok[0].title;
}

// repli : recherche plein texte (1 requête)
async function searchTitle(name, lang){
  const hint = lang === 'fr' ? ' arts martiaux mixtes' : ' mixed martial artist';
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2`
            + '&generator=search&gsrnamespace=0&gsrlimit=3'
            + '&gsrsearch=' + encodeURIComponent(name + hint)
            + '&prop=extracts&exintro=1&explaintext=1&exsentences=4&exlimit=20';
  let pages;
  try { pages = (await getJSON(url)).query?.pages || []; } catch(e){ return null; }
  pages.sort((a,b) => (a.index||99) - (b.index||99));
  const last = deaccent(name.trim().split(/\s+/).pop());
  for(const p of pages){
    if(!p.extract || !isFighterPage(p.title, p.extract, lang)) continue;
    if(last.length > 2 && !deaccent(p.title).includes(last)) continue;
    return p.title;
  }
  return null;
}

// texte intégral en clair (1 requête ; exlimit forcé à 1 hors exintro côté API)
async function fullText(title, lang){
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2`
            + '&redirects=1&prop=extracts&explaintext=1&titles=' + encodeURIComponent(title);
  const pages = (await getJSON(url)).query?.pages || [];
  const p = pages.find(x => !x.missing && x.extract);
  return p ? p.extract : null;
}

/* ═══════════════════════════════════════════════════════════════
   2. DÉCOUPAGE DU TEXTE
   ═══════════════════════════════════════════════════════════════ */

// sections utiles : celles qui parlent de l'humain, pas du palmarès
const HUMAN_SECTIONS = /^(?:early life|early years|background|youth|childhood|personal life|early life and (?:career|education)|life and career|education|amateur career|jeunesse|enfance|biographie|origines|vie priv[ée]e|vie personnelle|d[ée]buts?|formation|parcours|avant le mma|carri[èe]re amateur)/i;

function sections(text){
  const out = [{ title:'', body:'' }];
  for(const line of (text||'').split('\n')){
    const m = line.match(/^\s*(={2,6})\s*(.+?)\s*\1\s*$/);
    if(m) out.push({ title: m[2], body: '' });
    else out[out.length-1].body += line + '\n';
  }
  return out;
}

// le chapeau + les sections humaines, dans l'ordre du document
function humanText(text){
  const secs = sections(text);
  const lead = (secs[0]?.body || '').split(/\n\s*\n/).slice(0,2).join(' ');
  const rest = secs.slice(1).filter(s => HUMAN_SECTIONS.test(s.title)).map(s => s.body);
  return { lead: lead.trim(), body: rest.join('\n').trim(), all: [lead, ...rest].join('\n').trim() };
}

function splitSentences(text){
  const t = (text||'')
    .replace(/\s*\([^)]{0,80}?(?:prononc|pronounc|born|n[ée]e? le|IPA|API)[^)]*\)/gi, '')  // (prononcé …), (né le …)
    .replace(/\[[^\]]*\]/g, '')                                    // restes de notes
    .replace(/\b([A-Z])\./g, '$1\u0001')                           // initiales : J. K.
    .replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|vs|etc|approx|Inc|Ltd|env|ca|av|apr|Mme|Mlle|M)\./gi, '$1\u0001')
    .replace(/(\d)\.(\d)/g, '$1\u0001$2');
  return t.split(/(?<=[.!?])\s+(?=[«"'A-ZÀ-ÖØ-Þ])/)
          .map(s => s.replace(/\u0001/g, '.').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
}

/* ═══════════════════════════════════════════════════════════════
   3. LEXIQUES — ce qui touche vs ce qui est déjà affiché ailleurs
   ═══════════════════════════════════════════════════════════════ */

// Positif : le parcours humain. Poids fort = ce qui raconte vraiment quelque chose.
const HUMAN_LEX = [
  // galère matérielle
  [/\b(poverty|impoverish|destitute|slum|favela|shanty|penniless|could ?n'?t afford|couldn't afford|no money|went hungry|starv)/i, 6],
  [/\b(pauvret[ée]|mis[èe]re|d[ée]munis?|bidonville|favela|sans le sou|famille modeste|tr[èe]s pauvre|la faim)/i, 6],
  [/\b(homeless|slept (?:on|in) the|lived in a car)/i, 7],
  [/\b(sans[- ]abri|dormait dans|[àa] la rue)/i, 7],
  // travail avant le sport
  [/\b(worked as|working as|took a job|odd jobs|bricklayer|mason|construction|bus driver|janitor|waiter|dishwasher|factory|farmhand|shepherd|fisherman|miner|bouncer|plumber|roofer|painter|delivering|sold .{0,20}on the street|shined shoes)/i, 5],
  [/\b(travaill(?:ait|[ée])(?: comme| dans)|petits boulots|ma[çc]on|ouvrier|chauffeur|serveur|usine|[ée]boueur|videur|plombier|peintre en b[âa]timent|berger|p[êe]cheur|mineur|vendait)/i, 5],
  // famille
  [/\b(died when he was|died when she was|passed away|death of his (?:father|mother|brother|sister)|lost his (?:father|mother|brother|sister)|lost her (?:father|mother|brother|sister)|orphan|raised by his (?:grand|aunt|uncle|mother alone)|single mother|abandoned by|foster care)/i, 7],
  [/\b(d[ée]c[èe]s de (?:son|sa)|meurt (?:alors qu|quand)|perd (?:son p[èe]re|sa m[èe]re|son fr[èe]re)|orphelin|[ée]lev[ée] par (?:sa grand|son oncle|sa m[èe]re seule)|m[èe]re c[ée]libataire|abandonn[ée] par)/i, 7],
  // exil, guerre
  [/\b(refugee|asylum|fled|civil war|war-torn|displaced|emigrated|immigrated|moved to .{0,30} at the age of|left .{0,20} alone)/i, 7],
  [/\b(r[ée]fugi[ée]|asile|(?:a|ont|ayant) fui|fuyant|guerre civile|exil|[ée]migr|immigr|quitte (?:son pays|le pays)|arrive seul)/i, 7],
  // épreuves personnelles
  [/\b(bullied|bullying|discriminat|racism|racist abuse)/i, 6],
  [/\b(harcel[ée]|brimades|racisme|discrimination)/i, 6],
  [/\b(diagnosed with|cancer|leukemia|tumou?r|meningitis|coma|paralys|near-fatal|life-threatening|surviv(?:ed|or)|car (?:crash|accident)|stabbed|shot)/i, 7],
  [/\b(diagnostiqu[ée]|cancer|leuc[ée]mie|tumeur|m[ée]ningite|coma|paralys|accident de (?:voiture|la route)|surv[ée]cu|poignard)/i, 7],
  [/\b(addiction|alcoholis|alcoholic|drug (?:use|addiction)|sober|sobriety|rehab|depression|suicid)/i, 7],
  [/\b(addiction|alcoolis|alcoolique|drogue|sobre|sobri[ée]t[ée]|d[ée]sintox|d[ée]pression|suicid)/i, 7],
  [/\b(dropped out|expelled from school|left school at)/i, 5],
  [/\b(quitte l'?[ée]cole|abandonne ses [ée]tudes|renvoy[ée] de)/i, 5],
  // vocation
  [/\b(began|started) (?:training|practising|practicing|competing)/i, 4],
  [/\b(took up|introduced to) (?:wrestling|judo|sambo|boxing|karate|taekwondo|kickboxing|muay thai|jiu-?jitsu|capoeira|mma|mixed martial)/i, 4],
  [/\b(at the age of \d|since the age of \d|aged \d|when he was \d|when she was \d)/i, 3],
  [/\b(commence|d[ée]bute|se met (?:au|[àa] la)|pratique depuis|d[èe]s l'?[âa]ge de|[àa] l'?[âa]ge de \d)/i, 3],
  [/\b(son of|brother of|his father was|her father was|his mother was|family of (?:wrestlers|fighters))/i, 4],
  [/\b(fils de|fr[èe]re de|son p[èe]re [ée]tait|sa m[èe]re [ée]tait|famille de (?:lutteurs|sportifs))/i, 4],
  [/\b(military|army|served in the|police officer|firefighter|olympic|national team|world championship in (?:wrestling|judo|sambo))/i, 4],
  [/\b(militaire|arm[ée]e|a servi|policier|pompier|olympique|[ée]quipe nationale|champion du monde de (?:lutte|judo|sambo))/i, 4],
  [/\b(dream|promised|vowed|sacrific|to support his family|to provide for|motivat)/i, 4],
  [/\b(r[êe]v(?:e|ait)|promis|jur[ée]|sacrifi|pour nourrir|subvenir aux besoins)/i, 4]
];

// Négatif : le déroulé sportif — déjà couvert par l'ELO, le profil et le palmarès de la modale.
const NOISE_LEX = [
  [/\b(defeated|def\.|lost to|faced|was scheduled|is scheduled|bout|rematch|main event|co-main|undercard|pay-per-view|weigh-in|missed weight|title shot|interim|ranked (?:#|no)|signed with|released by|promotion|contract|debut(?:ed)? against)/i, 8],
  [/\b(unanimous decision|split decision|majority decision|technical knockout|submission (?:victory|win)|first round|second round|third round)/i, 8],
  [/\b(bat |a battu|d[ée]fait|affronte|remporte (?:le|la|son)|perd contre|d[ée]cision unanime|d[ée]cision partag[ée]|t[êe]te d'affiche|pes[ée]e|ceinture des poids|combat pr[ée]vu|revanche)/i, 8],
  [/\bUFC\s?\d|\bUFC on\b|\bFight Night\b|\bBellator\s?\d|\bPFL\b|\bONE Championship\b/i, 6],
  [/\b(record of|professional record|amateur record|win streak|s[ée]rie de victoires|invaincu)/i, 5],
  [/\b(as of \d{4}|he is ranked|she is ranked|il est class[ée]|elle est class[ée])/i, 5]
];

function score(sentence, lex){
  let s = 0;
  for(const [re, w] of lex) if(re.test(sentence)) s += w;
  return s;
}

/* Attention : en JS `\b` est ASCII. « \bémigre » ne matche jamais, parce qu'il
   n'y a pas de frontière de mot entre l'espace et le « é ». Toutes les entrées
   françaises commençant par un accent passaient donc à la trappe. On remplace
   la frontière gauche par un lookbehind « pas précédé d'une lettre », accents
   compris — et on refait les lexiques une fois pour toutes au chargement. */
function fixWordBoundaries(lex){
  return lex.map(([re, w]) => [
    new RegExp(re.source.replace(/^\\b/, '(?<![A-Za-zÀ-ÿ])'), re.flags), w
  ]);
}
for(let i = 0; i < HUMAN_LEX.length; i++) HUMAN_LEX[i] = fixWordBoundaries([HUMAN_LEX[i]])[0];
for(let i = 0; i < NOISE_LEX.length; i++) NOISE_LEX[i] = fixWordBoundaries([NOISE_LEX[i]])[0];

/* ═══════════════════════════════════════════════════════════════
   4. CHEMIN 1 — vraies phrases de fr.wikipedia
   ═══════════════════════════════════════════════════════════════ */

function cleanSentence(s, name){
  return s
    .replace(/\s*\([^)]*\)\s*/g, ' ')          // parenthèses : dates, translittérations, précisions
    .replace(/«\s*/g, '« ').replace(/\s*»/g, ' »')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickFrenchSentences(text, name){
  const zone = humanText(text);
  const src  = (zone.body || zone.lead);
  if(!src) return null;

  const cands = splitSentences(src)
    .map(s => cleanSentence(s, name))
    .filter(s => s.length >= 40 && s.length <= 260)
    .filter(s => !/^(?:Il|Elle) (?:est|a) class[ée]/i.test(s))
    .map((s, i) => ({ s, i, sc: score(s, HUMAN_LEX) - score(s, NOISE_LEX) }))
    .filter(o => o.sc >= MIN_SCORE);

  if(!cands.length) return null;

  // on garde les meilleures, puis on les remet dans l'ordre du texte pour que ça se lise
  const best = cands.slice().sort((a,b) => b.sc - a.sc).slice(0,4).sort((a,b) => a.i - b.i);

  let out = '', used = 0;
  for(const o of best){
    if(out.length + o.s.length + 1 > MAX_CHARS) continue;
    out = out ? out + ' ' + o.s : o.s;
    if(++used >= 3) break;
  }
  if(out.length < 60) return null;
  if(!/[.!?»]$/.test(out)) out += '.';
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   5. CHEMIN 2 — faits de en.wikipedia recomposés en français
   ═══════════════════════════════════════════════════════════════ */

// pays -> forme française avec sa préposition (« Né à Rio, au Brésil »)
const COUNTRY_FR = {
  'united states':'aux États-Unis','usa':'aux États-Unis','u.s.':'aux États-Unis','america':'aux États-Unis',
  'brazil':'au Brésil','russia':'en Russie','canada':'au Canada','mexico':'au Mexique',
  'england':'en Angleterre','scotland':'en Écosse','wales':'au pays de Galles','ireland':'en Irlande',
  'united kingdom':'au Royaume-Uni','australia':'en Australie','new zealand':'en Nouvelle-Zélande',
  'poland':'en Pologne','germany':'en Allemagne','france':'en France','netherlands':'aux Pays-Bas',
  'sweden':'en Suède','norway':'en Norvège','denmark':'au Danemark','finland':'en Finlande',
  'iceland':'en Islande','spain':'en Espagne','italy':'en Italie','portugal':'au Portugal',
  'switzerland':'en Suisse','austria':'en Autriche','belgium':'en Belgique','greece':'en Grèce',
  'georgia':'en Géorgie','armenia':'en Arménie','azerbaijan':'en Azerbaïdjan','kazakhstan':'au Kazakhstan',
  'ukraine':'en Ukraine','belarus':'en Biélorussie','moldova':'en Moldavie','lithuania':'en Lituanie',
  'latvia':'en Lettonie','estonia':'en Estonie','czech republic':'en République tchèque','slovakia':'en Slovaquie',
  'croatia':'en Croatie','serbia':'en Serbie','bulgaria':'en Bulgarie','romania':'en Roumanie','hungary':'en Hongrie',
  'china':'en Chine','japan':'au Japon','south korea':'en Corée du Sud','korea':'en Corée',
  'thailand':'en Thaïlande','philippines':'aux Philippines','singapore':'à Singapour','india':'en Inde',
  'indonesia':'en Indonésie','vietnam':'au Vietnam','mongolia':'en Mongolie',
  'nigeria':'au Nigeria','cameroon':'au Cameroun','south africa':'en Afrique du Sud','ghana':'au Ghana',
  'congo':'au Congo','angola':'en Angola','morocco':'au Maroc','algeria':'en Algérie','tunisia':'en Tunisie','egypt':'en Égypte',
  'iran':'en Iran','iraq':'en Irak','turkey':'en Turquie','pakistan':'au Pakistan','afghanistan':'en Afghanistan',
  'uzbekistan':'en Ouzbékistan','kyrgyzstan':'au Kirghizistan','tajikistan':'au Tadjikistan',
  'cuba':'à Cuba','jamaica':'en Jamaïque','dominican republic':'en République dominicaine',
  'venezuela':'au Venezuela','colombia':'en Colombie','peru':'au Pérou','chile':'au Chili',
  'argentina':'en Argentine','ecuador':'en Équateur','bolivia':'en Bolivie','uruguay':'en Uruguay',
  'israel':'en Israël','lebanon':'au Liban','jordan':'en Jordanie','syria':'en Syrie',
  'dagestan':'au Daghestan','chechnya':'en Tchétchénie','soviet union':'en Union soviétique','yugoslavia':'en Yougoslavie'
};

// disciplines : forme « il commence LE sambo » et forme « issu DU sambo »
const ARTS = {
  'combat sambo':      { le:'le sambo de combat',      de:'du sambo de combat' },
  'sambo':             { le:'le sambo',                de:'du sambo' },
  'freestyle wrestling':{ le:'la lutte libre',         de:'de la lutte libre' },
  'greco-roman wrestling':{ le:'la lutte gréco-romaine', de:'de la lutte gréco-romaine' },
  'folkstyle wrestling':{ le:'la lutte',               de:'de la lutte' },
  'wrestling':         { le:'la lutte',                de:'de la lutte' },
  'judo':              { le:'le judo',                 de:'du judo' },
  'brazilian jiu-jitsu':{ le:'le jiu-jitsu brésilien', de:'du jiu-jitsu brésilien' },
  'jiu-jitsu':         { le:'le jiu-jitsu',            de:'du jiu-jitsu' },
  'jujutsu':           { le:'le jiu-jitsu',            de:'du jiu-jitsu' },
  'muay thai':         { le:'le muay-thaï',            de:'du muay-thaï' },
  'kickboxing':        { le:'le kickboxing',           de:'du kickboxing' },
  'boxing':            { le:'la boxe',                 de:'de la boxe' },
  'karate':            { le:'le karaté',               de:'du karaté' },
  'kyokushin':         { le:'le karaté kyokushin',     de:'du karaté kyokushin' },
  'taekwondo':         { le:'le taekwondo',            de:'du taekwondo' },
  'capoeira':          { le:'la capoeira',             de:'de la capoeira' },
  'sanda':             { le:'le sanda',                de:'du sanda' },
  'wushu':             { le:'le wushu',                de:'du wushu' },
  'kung fu':           { le:'le kung-fu',              de:'du kung-fu' },
  'mixed martial arts':{ le:'les arts martiaux mixtes', de:'des arts martiaux mixtes' }
};
const ARTS_RE = new RegExp('\\b(' + Object.keys(ARTS).sort((a,b)=>b.length-a.length).join('|') + ')\\b', 'i');

// petits métiers -> français
const JOBS_FR = {
  'bricklayer':'maçon','mason':'maçon','construction worker':'ouvrier du bâtiment','construction':'ouvrier du bâtiment',
  'bus driver':'chauffeur de bus','truck driver':'chauffeur routier','taxi driver':'chauffeur de taxi',
  'janitor':'agent d\'entretien','waiter':'serveur','waitress':'serveuse','dishwasher':'plongeur',
  'factory worker':'ouvrier','farmhand':'ouvrier agricole','farmer':'agriculteur','shepherd':'berger',
  'fisherman':'pêcheur','miner':'mineur','bouncer':'videur','plumber':'plombier','roofer':'couvreur',
  'painter':'peintre en bâtiment','carpenter':'charpentier','mechanic':'mécanicien','welder':'soudeur',
  'security guard':'agent de sécurité','bartender':'barman','cook':'cuisinier','chef':'cuisinier',
  'baker':'boulanger','butcher':'boucher','electrician':'électricien','landscaper':'jardinier',
  'lifeguard':'maître-nageur','teacher':'enseignant','nurse':'infirmier','soldier':'soldat','police officer':'policier'
};
const JOBS_RE = new RegExp('\\b(' + Object.keys(JOBS_FR).sort((a,b)=>b.length-a.length).join('|') + ')\\b', 'i');

const ILLNESS_FR = {
  'cancer':'un cancer','leukemia':'une leucémie','leukaemia':'une leucémie','tumor':'une tumeur','tumour':'une tumeur',
  'meningitis':'une méningite','coma':'un coma','stroke':'un AVC','heart condition':'un problème cardiaque',
  'tuberculosis':'la tuberculose','malaria':'le paludisme','polio':'la poliomyélite'
};
const ILLNESS_RE = new RegExp('\\b(' + Object.keys(ILLNESS_FR).sort((a,b)=>b.length-a.length).join('|') + ')\\b', 'i');

function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Wikipedia écrit les âges en toutes lettres aussi souvent qu'en chiffres
const NUM_WORDS = {
  one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20
};
const NUM_RE = '\\d{1,2}|' + Object.keys(NUM_WORDS).join('|');
function toAge(x){
  if(!x) return null;
  const n = /^\d+$/.test(x) ? +x : NUM_WORDS[x.toLowerCase()];
  return (n >= 3 && n <= 40) ? String(n) : null;
}

/* Accord en genre : les gabarits portent {il} pour le sujet et {e} pour les
   participes (« élevé{e} »). On tranche au nombre de pronoms de l'article. */
function genderOf(text){
  const f = (text.match(/\b(she|her|hers|elle)\b/gi) || []).length;
  const m = (text.match(/\b(he|his|him|il)\b/gi) || []).length;
  return f > m ? 'f' : 'm';
}
function gender(s, g){
  return (s || '').replace(/\{il\}/g, g === 'f' ? 'elle' : 'il')
                  .replace(/\{e\}/g,  g === 'f' ? 'e' : '');
}

// « Makhachkala, Dagestan, Russian SFSR » -> { ville, pays FR }
function placeFR(raw){
  if(!raw) return null;
  const parts = raw.split(',').map(x => x.replace(/\s+/g,' ').trim()).filter(Boolean);
  if(!parts.length) return null;
  const city = parts[0].replace(/^(?:the|a)\s+/i, '');
  if(!/^[A-ZÀ-Þ]/.test(city) || city.length < 3 || city.length > 34) return null;
  let country = null;
  for(let i = parts.length - 1; i >= 1 && !country; i--){
    const k = parts[i].toLowerCase().replace(/\b(sfsr|ssr|soviet socialist republic|state|province)\b/g,'').replace(/\s+/g,' ').trim();
    country = COUNTRY_FR[k] || null;
  }
  return { city, country };
}

function factsFromEnglish(text){
  const z = humanText(text);
  const lead = z.lead, body = z.body, all = z.all;
  const F = {};

  // ── naissance / enfance ──
  let m = lead.match(/\bborn\b[^.]{0,70}?\bin\s+([A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}(?:,\s*[A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}){0,3})/)
       || body.match(/\bwas born\b[^.]{0,40}?\bin\s+([A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}(?:,\s*[A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}){0,3})/);
  if(m) F.birth = placeFR(m[1]);

  m = all.match(/\bgrew up\b[^.]{0,30}?\bin\s+([A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}(?:,\s*[A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\- ]{2,32}){0,2})/);
  if(m) F.raised = placeFR(m[1]);

  F.g = genderOf(all);

  // ── épreuves ──
  if(/\b(poverty|impoverished|destitute|penniless|humble beginnings|could ?n'?t afford|went hungry)\b/i.test(all)
     || /\b(?:family |they |he |she )?(?:was|were|grew up|grow up)\s+(?:dirt |very |extremely |quite )?poor\b/i.test(all)
     || /\bpoor (?:family|household|background|neighbou?rhood)\b/i.test(all))
    F.poverty = '{il} grandit dans la pauvreté';
  if(/\b(favela|slum|shanty ?town|ghetto|housing project|council estate)\b/i.test(all))
    F.hood = '{il} grandit dans un quartier difficile';
  if(/\b(homeless|slept on the (?:floor|street)|lived in (?:a|his|her) car)\b/i.test(all))
    F.homeless = '{il} connaît la rue';
  if(/\b(refugee|sought asylum|fled (?:the )?(?:war|conflict|country)|civil war|war-torn)\b/i.test(all))
    F.war = 'sa famille fuit la guerre';

  m = all.match(new RegExp('\\b(?:emigrated|immigrated|moved)\\s+to\\s+(?:the\\s+)?([A-ZÀ-Þ][A-Za-zÀ-ÿ\' .\\-]{2,26})(?:[^.]{0,40}?(?:at the age of|aged)\\s+(' + NUM_RE + '))?'));
  if(m){
    const pays = COUNTRY_FR[m[1].toLowerCase().trim()];
    const age = toAge(m[2]);
    if(pays) F.exil = '{il} émigre ' + pays + (age ? ' à ' + age + ' ans' : '');
  }

  m = all.match(new RegExp('\\b(?:his|her)\\s+(father|mother|brother|sister)\\b[^.]{0,60}?\\b(?:died|passed away)\\b(?:[^.]{0,30}?(?:aged\\s+|(?:he|she) was\\s+)(' + NUM_RE + '))?', 'i'))
   || all.match(new RegExp('\\blost (?:his|her)\\s+(father|mother|brother|sister)\\b(?:[^.]{0,30}?at (?:the age of )?(' + NUM_RE + '))?', 'i'));
  if(m){
    const who = { father:'son père', mother:'sa mère', brother:'son frère', sister:'sa sœur' }[m[1].toLowerCase()];
    const age = toAge(m[2]);
    F.deuil = '{il} perd ' + who + (age ? ' à ' + age + ' ans' : '');
  }
  if(!F.deuil && /\borphan(?:ed|age)?\b/i.test(all)) F.deuil = 'orphelin{e} très jeune';
  if(/\b(single mother|raised (?:alone )?by (?:his|her) mother)\b/i.test(all))
    F.mereSeule = '{il} est élevé{e} par sa mère seule';
  else if(/\braised by (?:his|her) (grandmother|grandparents|grandfather|aunt|uncle)\b/i.test(all))
    F.mereSeule = '{il} est élevé{e} par ses grands-parents';

  m = all.match(/\b(?:worked|working) as (?:an?|the)?\s*([a-z' \-]{3,26})/i)
   || all.match(/\bwas an?\s+([a-z' \-]{3,26})\s+(?:before|until|while)\b/i);
  if(m){
    const j = (m[1].match(JOBS_RE) || [])[1];
    if(j) F.metier = '{il} travaille comme ' + JOBS_FR[j.toLowerCase()];
  }

  if(/\bbullie[dr]\b|\bbullying\b/i.test(all))
    F.harcele = 'harcelé{e} à l\'école, {il} se réfugie dans les sports de combat';

  m = all.match(ILLNESS_RE);
  if(m && /\b(diagnosed|survived|battled|overcame|recovered|suffered)\b/i.test(all))
    F.maladie = '{il} surmonte ' + ILLNESS_FR[m[1].toLowerCase()];

  if(/\b(alcoholism|alcoholic|sobriety|got sober|drug addiction|substance abuse|rehab)\b/i.test(all))
    F.addiction = '{il} sort de l\'addiction';

  if(/\b(dropped out of (?:high )?school|left school at|expelled from school)\b/i.test(all))
    F.ecole = '{il} quitte l\'école tôt';

  // ── vocation ──
  m = all.match(new RegExp('\\b(?:began|started|took up|has been)\\s+(?:training in |practi[cs]ing |competing in )?([a-z\\- ]{3,26}?)\\s*(?:at|from|since)\\s+(?:the\\s+age\\s+of\\s+|age\\s+)(' + NUM_RE + ')', 'i'))
   || all.match(new RegExp('\\b(?:began|started|took up)\\s+(?:training in |practi[cs]ing )?([a-z\\- ]{3,26}?)\\b[^.]{0,20}?\\bwhen (?:he|she) was (' + NUM_RE + ')', 'i'));
  if(m){
    const a = (m[1].match(ARTS_RE) || [])[1];
    F.debut = { art: a ? ARTS[a.toLowerCase()].le : null, age: toAge(m[2]) };
  }
  if(!F.debut){
    m = all.match(/\b(?:began|started|took up)\s+(?:training in |practi[cs]ing )?([a-z\- ]{3,26})/i);
    const a = m && (m[1].match(ARTS_RE) || [])[1];
    if(a) F.debut = { art: ARTS[a.toLowerCase()].le, age: null };
  }

  // disciplines d'origine, hors « arts martiaux mixtes » qui n'apprend rien
  const arts = [];
  const rx = new RegExp(ARTS_RE.source, 'gi');
  let x;
  while((x = rx.exec(all)) !== null){
    const k = ARTS[x[1].toLowerCase()];
    if(!k || k.le === 'les arts martiaux mixtes') continue;
    if(!arts.some(a => a.le === k.le)) arts.push(k);
    if(arts.length >= 2) break;
  }
  if(arts.length) F.arts = arts;

  if(/\b(served in the (?:army|military|marines|navy)|was a soldier|military service)\b/i.test(all)) F.armee = '{il} passe par l\'armée';
  else if(/\b(police officer|was a cop|firefighter)\b/i.test(all)) F.armee = '{il} a d\'abord été dans la police';
  if(/\b(olympic|olympics|national team|world champion(?:ship)? in (?:wrestling|judo|sambo))\b/i.test(all))
    F.haut = 'passé{e} par le haut niveau amateur';

  return F;
}

/* Une seule proposition garde le sujet : « Né à X, il sort de l'addiction et
   travaille comme maçon » plutôt qu'une enfilade de « il ». L'élision se
   remet à zéro à chaque phrase. */
function elideSubjects(parts){
  let vu = false;
  return parts.filter(Boolean).map(s => {
    const porte = s.includes('{il}');
    const out = (porte && vu) ? s.replace(/^\{il\}\s+/, '') : s;
    if(porte) vu = true;
    return out;
  });
}

// propositions de même nature : virgules, puis « et » devant la dernière
function group(parts){
  if(parts.length <= 1) return parts[0] || '';
  return parts.slice(0, -1).join(', ') + ' et ' + parts[parts.length - 1];
}

function phrase(tete, suite, g){
  const [t, s] = (() => {
    const all = elideSubjects([...tete, ...suite]);
    return [all.slice(0, tete.filter(Boolean).length), all.slice(tete.filter(Boolean).length)];
  })();
  const out = [t.join(', '), group(s)].filter(Boolean).join(', ');
  if(!out) return '';
  return capitalize(gender(out, g).replace(/\s+/g, ' ').trim()) + '.';
}

function composeFrench(F){
  // Phrase 1 : d'où il vient et ce qu'il a traversé
  const tete = [];
  if(F.birth) tete.push('né{e} à ' + F.birth.city + (F.birth.country ? ', ' + F.birth.country : ''));
  if(F.raised && (!F.birth || F.raised.city !== F.birth.city)) tete.push('{il} grandit à ' + F.raised.city);

  // ordre : le plus marquant d'abord, on n'en garde que deux pour rester court
  const dur = [F.war, F.exil, F.deuil, F.harcele, F.addiction, F.maladie, F.poverty,
               F.homeless, F.mereSeule, F.hood, F.metier, F.ecole].filter(Boolean).slice(0, 2);

  // Phrase 2 : comment il arrive au combat
  const p2 = [];
  const second = F.arts && F.arts.find(a => !F.debut || a.le !== F.debut.art);
  if(F.debut){
    p2.push('{il} commence ' + (F.debut.art || 'les arts martiaux')
            + (F.debut.age ? ' à ' + F.debut.age + ' ans' : '')
            + (second ? ', puis ' + second.le : ''));
  } else if(F.arts){
    p2.push('{il} vient ' + F.arts.map(a => a.de).join(' et '));
  }
  if(F.armee) p2.push(F.armee);
  else if(F.haut && !F.debut) p2.push(F.haut);

  // seuil de confiance : l'origine seule ne raconte rien, on préfère ne rien afficher
  const richesse = dur.length * 2 + (F.debut ? 1 : 0) + (F.arts ? 1 : 0);
  if(richesse < 2) return null;

  const s1 = phrase(tete, dur, F.g);
  const s2 = phrase([], p2, F.g);
  let out = [s1, s2].filter(Boolean).join(' ');
  if(out.length > MAX_CHARS) out = s1 || s2;
  if(!out || out.length < 40 || out.length > MAX_CHARS) return null;
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   6. RÉSOLUTION D'UN COMBATTANT
   ═══════════════════════════════════════════════════════════════ */

async function resolve(name){
  // ── chemin 1 : fr.wikipedia, vraies phrases ──
  try {
    let t = await findTitle(name, 'fr');
    if(!t) t = await searchTitle(name, 'fr');
    if(t){
      const txt = await fullText(t, 'fr');
      const d = txt && pickFrenchSentences(txt, name);
      if(d) return { t: d, src: 'fr', title: t };
    }
  } catch(e){}

  // ── chemin 2 : en.wikipedia, faits recomposés en français ──
  try {
    let t = await findTitle(name, 'en');
    if(!t) t = await searchTitle(name, 'en');
    if(t){
      const txt = await fullText(t, 'en');
      const d = txt && composeFrench(factsFromEnglish(txt));
      if(d) return { t: d, src: 'en', title: t };
    }
  } catch(e){}

  return null;
}

/* ═══════════════════════════════════════════════════════════════
   7. PROGRAMME PRINCIPAL
   ═══════════════════════════════════════════════════════════════ */

// require() depuis un script de test : on expose l'analyse sans lancer la moulinette
if(require.main !== module){
  module.exports = { humanText, sections, splitSentences, score, HUMAN_LEX, NOISE_LEX,
                     pickFrenchSentences, factsFromEnglish, composeFrench, placeFR, slugKey };
  return;
}

(async function main(){
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FIGHTER HUB — descriptions des combattants   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if(FORCE) console.log('⚙  MODE FORCE — reconstruction complète\n');

  console.log('→ Téléchargement de la liste des combattants…');
  const rows = parseCSV(await get(TOTT)).filter(r => r.length > 1);
  const head = rows.shift();
  const iName = head.findIndex(h => h.trim().toUpperCase().includes('FIGHTER'));
  if(iName < 0){ console.error('✖ Colonne FIGHTER introuvable. En-têtes :', head); process.exit(1); }

  const seen = new Set();
  const names = [];
  for(const r of rows){
    const n = (r[iName] || '').trim();
    if(!n) continue;
    const k = slugKey(n);
    if(seen.has(k)) continue;
    seen.add(k);
    names.push(n);
  }
  console.log(`  ${names.length} combattants uniques\n`);

  let db = {};
  if(fs.existsSync(OUT)){
    try {
      db = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      console.log(`→ descriptions.json existant : ${Object.keys(db).length} entrées déjà traitées`);
    } catch(e){ console.log('→ descriptions.json illisible, on repart de zéro'); }
  }

  let todo;
  if(ONLY.length){
    todo = ONLY.map(o => names.find(n => slugKey(n) === slugKey(o)) || o);
    console.log(`\n⚠ MODE CIBLÉ — ${todo.length} combattant(s), rien n'est écrit\n`);
  } else {
    todo = names.filter(n => {
      const e = db[slugKey(n)];
      if(e === undefined) return true;                        // jamais tenté
      if(FORCE && (e === null || e.v !== SCHEMA)) return true; // reconstruction
      if(RETRY && e === null) return true;                    // réessai des échecs
      return false;
    });
    if(TEST){
      todo = todo.slice(0, 12);
      console.log('\n⚠ MODE TEST — 12 combattants seulement, rien n\'est écrit\n');
    }
  }

  if(!todo.length){
    console.log('\n✓ Rien à faire, tout est déjà résolu.');
    console.log('  (--retry pour réessayer les sans-description, --force pour tout reconstruire)\n');
    return;
  }
  console.log(`→ À traiter : ${todo.length}\n`);

  const stats = { fr:0, en:0, aucune:0 };
  let done = 0;
  const t0 = Date.now();

  for(let i = 0; i < todo.length; i += CONCURRENCY){
    const lot = todo.slice(i, i + CONCURRENCY);
    const res = await Promise.all(lot.map(async n => [n, await resolve(n)]));

    for(const [n, r] of res){
      if(r) r.v = SCHEMA;
      db[slugKey(n)] = r;
      stats[r ? r.src : 'aucune']++;
      done++;
      if(DRY){
        if(r) console.log(`  ✓ ${n}\n      [${r.src}] ${r.title}\n      « ${r.t} »\n`);
        else  console.log(`  ✖ ${n}\n      — rien d'exploitable\n`);
      }
    }

    if(!DRY && (done % 30 === 0 || done === todo.length)){
      fs.writeFileSync(OUT, JSON.stringify(db));
      const pct = (done / todo.length * 100).toFixed(1);
      const perSec = done / ((Date.now() - t0) / 1000);
      const reste = Math.round((todo.length - done) / perSec / 60);
      process.stdout.write(`\r  ${done}/${todo.length} (${pct}%) — trouvées : ${done - stats.aucune} — reste ~${reste} min   `);
    }

    await sleep(PAUSE_MS);
  }

  if(!DRY){ fs.writeFileSync(OUT, JSON.stringify(db)); console.log('\n'); }

  const ok = done - stats.aucune;
  console.log('\n─── Résultat ───');
  console.log(`  Phrases réelles fr.wikipedia   : ${stats.fr}`);
  console.log(`  Recomposé en FR depuis en.wiki : ${stats.en}`);
  console.log(`  Aucune description             : ${stats.aucune}`);
  console.log('  ─────────────────────────────');
  console.log(`  Taux de couverture             : ${(ok / done * 100).toFixed(1)}%`);

  if(DRY){
    console.log('\n→ Essai terminé, aucun fichier écrit.');
    console.log('  Si le rendu te va : lance la tâche « descriptions-complet ».\n');
  } else {
    console.log(`\n✓ descriptions.json écrit (${(fs.statSync(OUT).size / 1024).toFixed(0)} Ko)\n`);
  }
})().catch(e => {
  console.error('\n✖ Erreur fatale :', e.message);
  console.error('  Relance la commande, le script reprend où il s\'est arrêté.\n');
  process.exit(1);
});
