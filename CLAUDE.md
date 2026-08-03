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
- `build-events.js` → `events.json` (cartes UFC à venir, Wikipedia EN) — **optionnel** :
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
- `build-events.js --selftest` teste les parseurs **sans réseau ni Wikipedia**.
  Dans la liste `DIVISIONS`, « Light Heavyweight » doit rester **avant**
  « Heavyweight » : le motif du second est contenu dans le premier.
- Tout le mouvement de la section vit dans un seul bloc CSS (« PRONOS — mouvement
  et finitions ») et se coupe d'une règle avec `prefers-reduced-motion`. Rien n'y
  est nécessaire à la lecture : les animations arrivent en plus.
- Rejouer une animation demande de **retirer la classe, lire `offsetWidth`, la
  reposer** (`#pnView.swap`) — sinon un re-rendu du même onglet reste figé.
- La barre de nav déborde dès 3 entrées sur mobile (≈524 px de contenu pour 390 px
  d'écran) : elle défile, et `applyRoute()` recentre l'onglet actif. Une 4ᵉ entrée
  demandera de repenser le header.

## Roadmap

1. ~~Pages de classement P4P + par catégorie~~ — fait
2. ~~Description courte des combattants (intro Wikipedia)~~ — fait
3. ~~Vidéos de combat rattachées au palmarès (YouTube UFC + RMC)~~ — fait
4. ~~Pronostics : carte du week-end + marché des convictions~~ — fait
5. (Plus tard) Comparateur, URLs SEO, notes communautaires
