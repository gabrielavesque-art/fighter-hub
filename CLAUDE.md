[CLAUDE.md](https://github.com/user-attachments/files/31098994/CLAUDE.md)
# Fighter Hub

Site MMA statique, fan project. En ligne : fighter-hub.vercel.app

## Règles de travail

Avant toute modification :
1. Pose-moi les questions nécessaires — ne suppose pas.
2. Lis les fichiers concernés avant d'écrire quoi que ce soit.
3. Propose ton approche et attends ma validation avant d'exécuter.
4. Pour les gros changements visuels, montre une maquette d'abord.
5. Teste chaque fonction avant de me la livrer.

## Stack

- `index.html` — tout le site (HTML + CSS + JS, un seul fichier)
- Navigation : tableau `NAV` + routeur `applyRoute()` sur le `#hash`.
  **Ajouter une section = une ligne dans `NAV`, sa page en HTML, son cas dans `applyRoute()`.**
- `resolve-photos.js` → `photos.json` | `build-stats.js` → `stats.json` | `build-elo.js` → `elo.json`
- `build-descriptions.js` → `descriptions.json` (descriptions humaines, Wikipedia FR puis EN)
- `build-videos.js` → `videos.json` (combat ⇄ vidéo YouTube, chaînes UFC + RMC)
- `build-events.js` → `events.json` (cartes UFC à venir : Wikipedia EN, puis
  l'API MMA en secours si `MMA_API_KEY` existe) — **optionnel** :
  sans lui la section Pronos marche, on compose ses affiches à la main
- Scripts lancés via **GitHub Actions uniquement** (jamais en local) — Vercel auto-déploie sur push main
- Section **Pronos** (`#pronos`) : bankroll fictive en `localStorage`, cotes dérivées
  de `elo.json`, règlement automatique contre le CSV des résultats. Aucun serveur,
  aucun compte. Deux onglets : « La Carte » (combat par combat) et « Le Marché »
  (convictions longue durée, prix recalculé à chaque visite).

## Pièges

- `index.html` est gros — toujours `grep` l'ancre exacte avant un str-replace.
- Les cartes sont générées par **template string** (`grid.innerHTML = slice.map(...)`), pas createElement.
- `openModal` apparaît **2 fois** — cibler la définition, pas l'appel.
- `photos-retry` ne refait que les sans-photo → `photos-rebuild` (`--force`) pour tout reconstruire.
- Drapeaux = images flagcdn.com — **jamais d'emojis** (invisibles sur Windows).
- En JS, `\b` est ASCII : `\bémigre` ne matche **jamais**. Pour un motif français
  commençant par un accent, utiliser `(?<![A-Za-zÀ-ÿ])` (cf. `fixWordBoundaries`).
- Les sections plein écran partent de `top:58px` (sous le header) et sont
  **exclusives** — sinon elles recouvrent la nav, qui devient incliquable.
  Empilement : sections (z 150) < header (z 160) < fiche (z 200).
- Échap ne ferme **qu'une** couche : le handler des sections écoute sur `window` en
  **capture**, sinon `closeModal` (sur `document`) a déjà changé l'état lu.
- `p4pOrder()` ne mémorise rien tant que `eloDB` est vide — sinon un clic sur
  « P4P » pendant le chargement fige une liste vide pour toute la session.
- Les chips de division utilisent `replaceState` (pas d'entrée d'historique pour
  chacune) ; seule la nav fait `pushState`.
- `build-videos.js` a **deux** normalisations de nom : `keySlug` est la copie
  exacte du `slugKey` d'index.html (il fabrique les clés, toute divergence casse
  les recherches), `lookupSlug` replie les accents et ne sert qu'à lire les
  titres YouTube. Ne pas les confondre.
- Un titre YouTube contient souvent **deux** « vs » (l'événement + le combat) :
  se caler sur le premier rattache la vidéo au combat vedette. `matchPair` teste
  toutes les occurrences et garde celle collée au mot-clé (« Free Fight »…).
- Jamais de `search.list` par combat : 100 unités de quota l'appel, contre 1 par
  tranche de 50 vidéos en balayage de chaîne. Un run complet coûte ~1 500 unités
  sur les 10 000/jour, un run incrémental quelques dizaines.
- `videos.json` demande le secret GitHub `YOUTUBE_API_KEY`.
- `node build-videos.js --selftest` teste le parseur **sans clé ni réseau
  YouTube** — à lancer avant tout changement des regex de titre.

- `pnPropCat()` et `pnChampions()` ne mémorisent **rien** tant que `fightsLoaded`
  est faux — même piège que `p4pOrder()` : ouvrir la section pendant le chargement
  figerait un marché vide pour toute la session.
- Le champion d'une division est **déduit** du dernier « UFC <div> Title Bout »
  gagné (`h.title`, posé dans `loadFights`), intérimaires et tournois exclus.
  Aucune source externe — ne pas ajouter de scrape pour ça.
- Les identifiants de convictions contiennent déjà des `|` (`champ|Heavyweight`) :
  ne jamais empiler une seconde valeur dans le même `data-`, elle part dans le
  mauvais champ au `split`. Un attribut par valeur (`data-buy` + `data-side`).
- Les onglets `#pnTabs` vivent **hors** de `#pnView` : ils survivent aux re-rendus,
  donc on les branche une seule fois — pas dans `pnWire()`, qui rebranche à chaque
  rendu ce qui est à l'intérieur.
- `openPronos()` ne réécrit pas l'URL quand le hash est un `#duel-…` : c'est lui
  qui porte le ticket du pote, `pnBoot()` le relit après le chargement des données.
- `build-events.js` récupère aussi l'affiche de l'événement (`| image =` de
  l'infobox) et résout les URL en **un seul appel groupé**, 50 fichiers max.
- `build-posters.js` → `posters.json` : les affiches des **783 soirées passées**,
  que build-events.js ne voit pas (il ne regarde que l'avenir). Il ne devine
  jamais un titre de page : « List of UFC events » porte déjà le lien exact de
  chacune (`[[UFC 3|UFC 3: The American Dream]]`). Incrémental, ~15 min au
  premier run.
- `posterKey()` (script) et `evPosterKey()` (site) doivent rester **jumeaux** :
  ils replient les accents (NFD) avant de filtrer, contrairement à `slugKey()`.
  Wikipedia écrit « Medić », ufcstats « Medic » — `slugKey()` donnerait « medi »
  d'un côté et « medic » de l'autre, et posters.json ne se raccrocherait à rien.
- Une affiche UFC est en portrait, la vignette en paysage : `object-fit:cover`
  rognait les visages. On pose l'affiche **entière** (`contain`) sur une copie
  floutée d'elle-même. Attention à la spécificité : `.pn-ethumb img` (0,1,1)
  écrase `.pn-shot-fg` (0,1,0) — d'où `.pn-ethumb .pn-shot-fg`.
- Quand une source rend zéro, `--dump` (tâche `events-dump`) recrache le
  wikitext brut **et** la réponse de l'API : une exécution suffit à corriger un
  parseur, au lieu de deviner. Wikipedia n'est pas joignable depuis toutes les
  machines de développement.
- `build-events.js --selftest` teste les parseurs **sans réseau ni Wikipedia**.
  Dans la liste `DIVISIONS`, « Light Heavyweight » doit rester **avant**
  « Heavyweight » : le motif du second est contenu dans le premier.
- Les pages d'événement récentes remplacent le tableau de carte par le modèle
  `{{MMAevent bout|Division|[[A]]|vs.|[[B]]|...}}` (un champ par ligne, fermé
  par `}}`). `parseBouts()` lit les deux formes : ignorer la seconde revient à
  voir une carte publiée comme vide.
- Le plan gratuit de l'API MMA (source 2) **ne couvre qu'une fenêtre de ~3
  jours** autour d'aujourd'hui (`"Free plans do not have access to this
  date"`) : elle ne comblera jamais un trou à plusieurs semaines. Elle reste
  branchée pour le jour où le plan change, pas comme filet pour les cartes
  lointaines — c'est Wikipedia qui doit rester exhaustif.
- `{{dts}}` de Wikipedia accepte le mois **en toutes lettres** (`{{dts|2026|Apr|04}}`).
  Le compléter par des zéros donnait `2026-Apr-04` : tri alphabétique, comparaison
  fausse, et des soirées déjà jouées annoncées comme à venir — donc pariables.
  Toute date passe par `iso()` côté script et par `evISO()` côté site, qui rattrape
  aussi les anciens fichiers.
- Quand une page d'événement n'a pas encore de carte, `pnMainFromName()` déduit
  l'affiche principale du **nom** (« UFC 330: Makhachev vs. Machado Garry ») en
  cherchant le combattant actif le mieux classé pour chaque patronyme. Le combat
  est marqué `derived` et le signale à l'écran : on infère, on ne l'invente pas.
- Deux fonctions lisent le nom d'une soirée, **ne pas les confondre** :
  `pnMainFromName()` cherche dans `FIGHTERS` et n'accepte que les **actifs** —
  pour une carte pas encore publiée, où il n'y a encore aucun combat à
  regarder. `pnMainIndex(nom, bouts)` cherche dans les combats **déjà connus**
  de la soirée, publiés ou joués — pour les cartes passées (où « Khabib » a
  pris sa retraite et n'existe plus dans `FIGHTERS`) **et** pour les cartes à
  venir déjà publiées : `pnEvents()` l'applique aux deux branches (`past` et
  `future`), sinon la vignette montre le premier combat de la source (Wikipedia,
  l'ordre de scrape) au lieu du main event — bug réel, vu en prod sur UFC 330
  qui montrait Njokuani/Neal à la place de Makhachev/Machado Garry. Sans ce tri
  la vignette d'UFC 254 montrait deux préliminaires, l'ordre venant de
  l'itération des palmarès. Il reconnaît un prénom (« Khabib »), un patronyme
  composé (« Machado Garry »), et retombe sur un seul camp reconnu quand
  l'autre est un surnom (« Cowboy », « The Korean Zombie ») : un combattant ne
  figure qu'une fois par carte, donc un seul combat le contient. 646 des 669
  soirées nommées « A vs B » retrouvent leur vedette ; les 23 restantes sont
  des `TUF: Team X vs Team Y`, où les noms
  sont ceux des **coachs** — l'échec est le bon comportement.
- Une carte lointaine n'a pas de tableau, mais ses combats sont annoncés **en
  prose** (« A Lightweight bout between [[A]] and [[B]] is expected… »). Aucun
  « vs. » dans ces phrases : `parseProse()` les lit, en dernier recours
  seulement, quand `parseBouts()` n'a rien trouvé. Il raisonne **par paragraphe
  et jamais par phrase** : le démenti arrive à la phrase d'après (« However, X
  withdrew »), et découper sur le point ferait entrer un combat annulé dans la
  carte. Un paragraphe qui annonce un remplaçant est donc écarté avec le reste —
  mieux vaut manquer une affiche que d'en promettre une morte. Ces combats
  portent `announced:true` et le disent à l'écran.
- Le carrousel de la hero (`renderHeroEvents`) vit sur `events.json` : sans le
  fichier, `#heroEvents` reste `hidden` et la hero reprend toute sa largeur
  (`:has()` en CSS). Une seule horloge tourne, pour la diapo visible.
- Le workflow tourne **deux fois par jour** sur les cartes (`cron`) : un
  déclenchement planifié ne fournit aucune entrée, d'où `TACHE: inputs.tache ||
  'events'` en `env` — ne pas relire `inputs.tache` ailleurs.
- Un pronostic se pose **avant** le combat : dès que `pnResult()` trouve un
  résultat, le formulaire de pari disparaît au profit du verdict, et le handler
  refuse aussi de son côté. Le composeur n'accepte que des dates à venir.
  Surtout : c'est la **date** qui ferme les paris (`pnPast`), pas la présence
  d'un résultat — le CSV amont a un jour de retard, et cette fenêtre laissait
  parier sur une soirée déjà jouée.
- `.ph` est en `position:absolute` : **tout** conteneur de photo doit porter
  `position:relative`, sinon l'image se cale sur le premier ancêtre positionné
  et déborde par-dessus la carte entière (le cas s'est produit sur `.pn-face`).
- Les combats des cartes annoncées ne sont **pas** stockés : ils vivent dans
  `events.json` et n'entrent dans `PN.bouts` qu'au moment où l'on parie dessus
  (et en ressortent si le pari est annulé). `pnBoutById()` cherche des deux côtés.
- Tout le mouvement de la section vit dans un seul bloc CSS (« PRONOS — mouvement
  et finitions ») et se coupe d'une règle avec `prefers-reduced-motion`. Rien n'y
  est nécessaire à la lecture : les animations arrivent en plus.
- Rejouer une animation demande de **retirer la classe, lire `offsetWidth`, la
  reposer** (`#pnView.swap`) — sinon un re-rendu du même onglet reste figé.
- La barre de nav déborde dès 3 entrées sur mobile (≈524 px de contenu pour 390 px
  d'écran) : elle défile, et `applyRoute()` recentre l'onglet actif. Une 4ᵉ entrée
  demandera de repenser le header.

- `pnEvents()` réindexe les **822 soirées** (passées via `f.history`, à venir via
  `events.json`) sans rien charger de plus : chaque combat y figure deux fois,
  d'où la clé triée `slugKey(a)|slugKey(b)`.
- `ufc_fight_stats.csv` pèse **7,5 Mo** : jamais au démarrage. `loadFightStats()`
  ne part qu'au premier clic sur « Stats du combat », et une seule fois par visite.
- Le comparateur réutilise `fighterProfile()` (les 5 axes des fiches) : ne pas
  recalculer un second modèle à côté.
- Un seul volet ouvert à la fois (`pnOpenPanel`), sinon deux comparateurs
  déroulés poussent la page de plusieurs écrans.
- Les six listes de « Mes tickets » (et le duel) passent toutes par
  `pnLineHTML()` : y ajouter une colonne se fait **là**, pas dans un des appels,
  sinon une liste sur six diverge. Les anciennes classes `.pn-what` / `.pn-res` /
  `.pn-gain` n'existent plus.
- L'affiche d'une soirée est en portrait, la vignette en paysage : on recadre en
  `cover` avec `object-position:center 14%` — le haut d'une affiche UFC porte le
  logo et les visages, le bas n'est que la liste des sponsors. Le fond flouté
  (`.pn-shot-bg`) reste dessous pour les images déjà en paysage.
- `profileAvg()` est la moyenne **arithmétique** des cinq axes, pas un indice
  pondéré : un 5,0 veut dire « complet », pas « moyen partout ».

- **Deux bankrolls distinctes, jamais confondues.** `PN.bank` (paris, marché) est
  toujours en `localStorage`, éditable en local comme avant — sécuriser les
  paris est un chantier à part, plus gros, pas fait. Les **crédits vérifiés**
  (prime quotidienne, classement) vivent dans Supabase : `SBProfile.bank`. Le
  bandeau des pronos (`pnBankHTML()`) affiche la première ; la page compte
  affiche les deux, dans des sections séparées et étiquetées (« locale, non
  vérifiable » vs le classement). Ne jamais faire bouger l'une en affichant un
  bouton dans le bandeau de l'autre — d'où le lien `<a href="#compte">`
  (`.pn-claim`) plutôt qu'un bouton qui créditerait un nombre différent de
  celui sous les yeux.
- La prime quotidienne ne peut plus être trafiquée en éditant le
  `localStorage` : `bank`/`daily_*` vivent dans la table `profiles` de
  Supabase, dont la policy RLS n'autorise **aucun** `UPDATE` client — la seule
  porte est la fonction Postgres `claim_daily()` (SECURITY DEFINER, bypasse la
  RLS), qui calcule tout avec `now()`, l'horloge du **serveur**. Avancer celle
  du visiteur ne donne donc plus rien (testé : horloge locale avancée d'un an,
  `fhCanClaim()` reste `false`). Ce que ça n'arrête toujours pas : un vrai
  compte piraté côté Supabase — hors de portée d'un fan project.
- Connexion **anonyme** (`sb.auth.signInAnonymously()`), pas de mail : un
  identifiant par navigateur, créé au premier `sbEnsureAuth()`. Perdre le
  `localStorage` (ou changer d'appareil) perd l'accès à ce compte-là — la vraie
  connexion par e-mail (roadmap, étape 7) réglera ça.
- `sb` démarre à `null` et **le chargement de la librairie Supabase ne bloque
  jamais rien** : elle arrive par un `<script>` injecté en tâche de fond
  (`sbLoadLib()`), pas un `<script src>` statique dans le HTML. Un `<script
  src>` classique aurait retardé TOUT le site (grille, recherche) derrière un
  aller-retour vers jsdelivr avant le premier affichage — bug réel trouvé en
  testant un CDN bloqué, pas juste un artefact de sandbox.
- Trois états à distinguer pour l'UI du compte, jamais deux : `SBReady`
  (connecté, tout s'affiche), `SBFailed` (a essayé et définitivement échoué —
  « Indisponible »), ni l'un ni l'autre (en cours — « Connexion… »). Confondre
  « pas encore essayé » et « a échoué » fait clignoter « Indisponible » une
  fraction de seconde à chaque chargement, avant que la vraie tentative parte.
- `sbLoadBoard()` ne part que si `SBReady` est vrai, jamais juste parce que
  `_sbBoard` est `null` : le lancer plus tôt (avant que `sb` existe) le ferait
  échouer silencieusement et figer un classement vide pour toute la session —
  même piège que `p4pOrder()` avec `eloDB`.
- Le pseudo se tape dans `PN.name` (local, immédiat) ET se synchronise vers
  `SBProfile.username` via `set_username()` (RPC, débattu 700 ms). Le
  callback du debounce ne doit **jamais** appeler `acctRender()` : un
  re-rendu de `#acctView` pendant la frappe recrée l'`<input>` et le focus
  saute hors du champ. Il invalide juste `_sbBoard`, qui se rafraîchira au
  prochain rendu naturel de la page.
- La table `profiles` n'a **aucune** policy d'`UPDATE` cliente : même le
  pseudo passe par une fonction (`set_username()`), pas par un `.update()`
  direct — sinon n'importe quel champ, `bank` compris, deviendrait modifiable
  par la même porte.
- La vue `public.leaderboard` ne montre que `username` + `bank` + `rank`,
  jamais `id` — une policy RLS qui laisserait fuiter les `id` d'autres
  utilisateurs permettrait de deviner qui a quel solde en croisant avec
  `auth.users`. Elle tourne avec les privilèges de son **propriétaire**
  (`security_invoker` non posé), donc elle voit toutes les lignes de
  `profiles` malgré la RLS qui, elle, bloque un `SELECT` direct sur la table.
- La clé `sb_publishable_…` est faite pour être publique (elle est dans
  `index.html`, donc dans le dépôt Git, donc visible de tout le monde) — la
  RLS et les policies sont la seule protection, pas le secret de la clé. La
  clé `sb_secret_…`, elle, ne doit **jamais** apparaître dans ce fichier ni
  dans `index.html` : ce projet n'en a besoin nulle part, tout passe par la
  clé publique + les fonctions `SECURITY DEFINER`.
- Deux listes de favoris, **jamais mélangées** : `PN.fav` garde des **noms de
  soirées**, `PN.favF` des **clés de combattants** (`slugKey`). Les fonctions
  aussi sont jumelles et distinctes : `pnFav()` / `fhFav()`.
- L'étoile de suivi vit **dans** `.card`, qui ouvre la fiche au clic : les deux
  gestionnaires filtrent sur `closest('[data-star]')`, sinon suivre quelqu'un
  ouvrirait sa fiche. Même piège qu'avec `[data-fav]` sur les affiches.
- Un combattant porte plusieurs étoiles à l'écran en même temps (sa carte, sa
  fiche par-dessus, le profil) : `fhPaintStar()` les repeint **par la clé**.
  Ne pas re-rendre la grille pour ça — `render()` relance l'hydratation des photos.
- `fhUpcomingIndex()` s'appuie sur l'ordre de `pnEvents()` (du plus lointain au
  plus proche) pour que la **dernière** écriture par clé soit la soirée la plus
  proche. Balayer les soirées et garder la première match donnerait le combat le
  plus **lointain**. `acctRender()` remet l'index à zéro à chaque rendu.
- `pnLoad()` est appelé **deux fois** au démarrage : très tôt, pour que les
  étoiles soient dessinées avec les cartes et que le header montre le solde ;
  puis par `pnBoot()` une fois les combats là. C'est sans effet — le stockage est
  la seule source, et tout ce qui écrit passe par `pnSave()`.
- Le bouton du compte est dans le header, **pas** dans `NAV` : la barre débordait
  déjà à trois entrées. Il coûte 36 px, repris sur le logo et les marges en
  dessous de 760 px. Il ne reste plus rien à prendre — une entrée de plus
  demandera de repenser le header pour de bon.
- `#pnBank` vit **hors** de `#pnView` : le bouton de prime qu'il contient est
  branché par `pnRender()`, pas par `pnWire()` — même piège que `#pnTabs`.
- « Mes soirées », sur le compte, réutilise `pnEvCardHTML()` (donc les vraies
  affiches/photos du calendrier) au lieu de simples lignes de texte. Elle pose
  `data-open` avec un **nom de soirée**, exactement comme « Mes combattants »
  pose `data-open` avec une **clé de combattant** juste au-dessus — un
  sélecteur `[data-open]` non scopé dans `acctWire()` essaierait donc d'ouvrir
  la fiche d'un combattant qui n'existe pas. D'où `.ac-flist [data-open]`
  (combattants → fiche) et `.ac-evgrid [data-open]` (soirées → pronos),
  jamais l'un pour l'autre.

## Roadmap

1. ~~Pages de classement P4P + par catégorie~~ — fait
2. ~~Description courte des combattants (intro Wikipedia)~~ — fait
3. ~~Vidéos de combat rattachées au palmarès (YouTube UFC + RMC)~~ — fait
4. ~~Pronostics : carte du week-end + marché des convictions~~ — fait
5. ~~Calendrier complet, comparateur, notes de combat, favoris~~ — fait
6. ~~Compte local : pseudo, combattants suivis, prime quotidienne~~ — fait
7. ~~Crédits vérifiés (Supabase, connexion anonyme) + classement~~ — fait.
   Reste local : la bankroll de paris (`PN.bank`, tickets, marché) — sécuriser
   les paris aussi est un chantier séparé, plus gros, pas commencé.
8. (Plus tard) Vraie connexion par e-mail (lien magique), pour que le compte
   Supabase survive à un changement d'appareil — aujourd'hui la connexion est
   anonyme, liée au navigateur. `sb.auth.signInAnonymously()` est le seul
   appel à remplacer dans `sbEnsureAuth()`.
9. (Plus tard) Journal d'événement, actualités (RSS), URLs SEO
