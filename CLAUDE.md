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
- `resolve-photos.js` → `photos.json` | `build-stats.js` → `stats.json` | `build-elo.js` → `elo.json`
- `build-descriptions.js` → `descriptions.json` (descriptions humaines, Wikipedia FR puis EN)
- Scripts lancés via **GitHub Actions uniquement** (jamais en local) — Vercel auto-déploie sur push main

## Pièges

- `index.html` est gros — toujours `grep` l'ancre exacte avant un str-replace.
- Les cartes sont générées par **template string** (`grid.innerHTML = slice.map(...)`), pas createElement.
- `openModal` apparaît **2 fois** — cibler la définition, pas l'appel.
- `photos-retry` ne refait que les sans-photo → `photos-rebuild` (`--force`) pour tout reconstruire.
- Drapeaux = images flagcdn.com — **jamais d'emojis** (invisibles sur Windows).
- En JS, `\b` est ASCII : `\bémigre` ne matche **jamais**. Pour un motif français
  commençant par un accent, utiliser `(?<![A-Za-zÀ-ÿ])` (cf. `fixWordBoundaries`).
- Trois couches plein écran empilées : classement (z 150) < fiche (z 200) < page ELO
  (z 300). Échap ne doit en fermer **qu'une** → le handler du classement écoute sur
  `window` en **capture**, sinon `closeModal` (sur `document`) a déjà changé l'état lu.
- `p4pOrder()` ne mémorise rien tant que `eloDB` est vide — sinon un clic sur
  « Classement » pendant le chargement fige une liste vide pour toute la session.

## Roadmap

1. ~~Pages de classement P4P + par catégorie~~ — fait
2. ~~Description courte des combattants (intro Wikipedia)~~ — fait
3. (Plus tard) Comparateur, URLs SEO, notes communautaires
