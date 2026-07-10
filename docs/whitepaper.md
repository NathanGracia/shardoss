# Shardoss — Whitepaper (MVP)

Idle/clicker de collection de memes, extension du party-game Memoss. Document de conception original fourni par l'utilisateur.

## 1. Pitch

Shardoss est un jeu idle/clicker de collection de memes, connecté au party-game Memoss existant. Les memes collectionnés et leur valeur ne sont pas fixés à la main : ils dérivent des statistiques d'usage réelles de Memoss (popularité des médias, qualité des légendes reçues). Gagner en visibilité dans une partie de Memoss devient une source directe de progression dans Shardoss.

L'affichage des informations Shardoss dans l'interface Memoss est optionnel, activable via un toggle (opt-in) pour ne pas imposer le système aux joueurs qui veulent juste jouer à Memoss.

### 1.1 Direction artistique

La direction visuelle part du mécanisme central du jeu plutôt que d'un style générique : chaque carte se révèle progressivement, morceau par morceau, façon verre brisé qu'on reconstitue (détail en section 5.2).

Palette — Encre `#16121F` (fond, aubergine très sombre plutôt qu'un noir pur), papier ticket `#F3E9D8` (crème chaud, surface des cartes), rouge coupon `#E14953` (accent de marque : boutons, éléments d'interface). Les tiers suivent un code couleur classique du genre loot pour rester lisibles instantanément : Common gris ardoise, Rare bleu, Epic violet, Legendary doré.

Typographie — une police mono pour tous les compteurs numériques (solde Dolloss, points/sec), afin de renforcer l'effet de compteur mécanique quand le solde s'incrémente par à-coups (voir section 5.1).

Éclats non révélés — gris uni, sans texture ni hachurage, pour rester sobre même sur les cartes à fort nombre d'éclats.

## 2. Rareté dynamique des memes

Chaque média de la galerie déjà utilisé dans Memoss se voit attribuer un tier et une valeur de production. Le recalcul (popularité, qualité, tier, points_per_sec) s'effectue une fois par jour plutôt qu'à chaud à chaque partie, afin de lisser les variations et de permettre une communication claire aux joueurs (voir 2.3).

### 2.1 Tier — basé sur la popularité uniquement

La popularité est mesurée par le nombre de fois qu'un média a été tiré en GameRound (ou le nombre total de votes reçus). Les médias sont classés par percentile de popularité sur l'ensemble de la galerie :

| Tier | Percentile de popularité |
|---|---|
| Legendary | Top 5% |
| Epic | 15% suivants |
| Rare | 30% suivants |
| Common | Reste (50%) |

La qualité n'intervient jamais dans le calcul du tier — la popularité prime, conformément au principe d'équilibrage retenu. Avec environ 200 médias dans la galerie actuelle, le volume est jugé suffisant pour que chaque tier soit correctement peuplé, sans risque de tiers vides ou anecdotiques.

### 2.2 Multiplicateur qualité — départage à l'intérieur d'un tier

La qualité correspond à la note moyenne des légendes reçues par le média (`total_stars / vote_count` dans le modèle Memoss). Les médias d'un même tier sont classés par percentile de qualité entre eux, ce qui détermine un multiplicateur appliqué à leur production de points :

- Multiplicateur qualité : ×0.8 à ×1.5

Ce mécanisme permet de différencier deux memes très populaires (même tier) sans jamais faire changer un meme de tier sur la base de sa seule qualité.

### 2.3 Recalcul journalier et changement de tier

Un batch journalier recalcule `popularity_score`, `quality_score`, `tier` et `points_per_sec` pour l'ensemble des médias. Les joueurs sont informés chaque jour des mouvements de tier (up et down) survenus dans chaque catégorie, s'il y en a — pour qu'un changement de seuil de déblocage ne soit jamais une surprise silencieuse.

Si un média monte de tier, le seuil de shards requis pour le débloquer augmente. Les joueurs ayant déjà débloqué ce média avant le changement conservent leur déblocage acquis. Les joueurs en cours de collecte doivent compléter la différence pour atteindre le nouveau seuil.

Si un média descend de tier, le seuil de shards requis diminue. Un joueur qui possédait déjà plus de shards que le nouveau seuil se retrouve avec un excédent : cet excédent est automatiquement converti en Dolloss, exactement comme un doublon classique (voir section 7).

## 3. Boucle idle — génération de points

Chaque meme débloqué dans la collection d'un joueur génère des points par seconde en continu. Pas de clic actif dans ce MVP : la seule interaction disponible sur une carte est un lien de téléchargement, qui pointe vers l'endpoint média Memoss existant.

| Tier | Points/sec de base |
|---|---|
| Common | 1 |
| Rare | 3 |
| Epic | 6 |
| Legendary | 10 |

Points/sec final = points/sec de base du tier × multiplicateur qualité (0.8–1.5).

## 4. Acquisition des memes — pont avec Memoss

### 4.1 Fin de partie Memoss → distribution de shards

À la fin d'une partie (3 rounds, donc jusqu'à 3 médias différents), le rang utilisé pour la distribution de shards n'est pas recalculé round par round : c'est le classement global de la partie entière (score cumulé sur les 3 rounds, déjà utilisé pour désigner le gagnant côté Memoss) qui sert de base. Ce même rang par joueur est appliqué à la distribution de shards de chacun des médias joués pendant la partie — un joueur classé 1er sur le score global reçoit le plus de shards sur les 3 médias de la partie, pas seulement sur celui où il a le mieux performé individuellement.

> **Note d'implémentation** (clarifiée avec l'utilisateur après relecture — voir `docs/plan.md` §Contexte) : en pratique, le rang qui compte est celui des **légendes** (réponses), pas celui des joueurs — Memoss classe déjà les meilleures légendes en fin de partie. Le comportement implémenté : classement des légendes de toute la partie par qualité, top N (N = nombre de joueurs) reçoivent respectivement N, N-1, ..., 1 shards **sur leur propre média**, pas sur les 3 médias de la partie. Voir `webhook_router.py` dans le repo Shardoss pour le détail.

La distribution reste proportionnelle au nombre de joueurs N de la partie, afin qu'une petite partie ne distribue pas autant de shards qu'une grande partie :

- Rang 1 → N shards
- Rang 2 → N−1 shards
- …
- Dernier rang noté → 1 shard

Exemple : une partie à 4 joueurs distribue au total 4+3+2+1 = 10 shards ; une partie à 10 joueurs en distribue 55.

Un meme se débloque quand le joueur atteint le seuil de shards requis pour son tier :

| Tier | Shards requis pour débloquer |
|---|---|
| Common | 3 |
| Rare | 6 |
| Epic | 12 |
| Legendary | 24 |

### 4.2 Doublons → Dolloss

Si une shard est gagnée pour un meme déjà 100% débloqué (ou en excédent suite à une baisse de tier, voir 2.3), elle se convertit automatiquement en Dolloss — la monnaie unique du jeu (voir section 6 pour le détail de l'économie).

### 4.3 Restriction comptes

La collection persistante est réservée aux joueurs connectés via le compte partagé cooloss (`account_uid`). Les invités Memoss (pseudo libre, sans compte) n'accumulent aucune progression Shardoss.

## 5. Page collection — rendu visuel des gains

Toutes les cartes possédées par un joueur (au moins 1 shard, débloquées ou non) sont affichées en vidéo, en lecture automatique, muette, et en boucle — comme un gif. Seules les cartes correspondant aux médias déjà touchés par le joueur (au moins 1 shard) sont chargées et rendues sur la page ; la galerie complète (~200 médias) n'est jamais chargée en une fois, ce qui limite le nombre de vidéos en lecture simultanée et fait croître la charge progressivement avec la collection du joueur.

### 5.1 Rythme des gains — synchronisation sur la boucle vidéo

`points_per_sec` reste calculé uniquement à partir du tier et du multiplicateur qualité — la durée du média n'influence jamais le taux de gain économique, pour ne pas avantager les vidéos longues.

En revanche, le compteur affiché au joueur ne progresse pas en continu : il avance par à-coups, à chaque fin de boucle vidéo d'une carte. Le gain affiché à ce moment-là est `duration_seconds × points_per_sec` de la carte concernée. Avec plusieurs cartes actives à des rythmes différents, chaque carte déclenche son propre "pop" de gain de façon indépendante.

Le solde réel du joueur reste calculé côté serveur en continu (temps écoulé × somme des `points_per_sec` de la collection), notamment pour les gains accumulés hors-ligne. Le rythme par à-coups n'est qu'un comportement d'affichage côté client, pas le mécanisme de calcul du solde.

`duration_seconds` est stockée sur `MemeCard`, à partir de la durée réelle de la vidéo source (récupérée depuis Memoss ou extraite une fois via ffprobe).

### 5.2 Cartes non débloquées — morcellement façon verre brisé

Une carte avec des shards mais sous le seuil de déblocage du tier reste visible et joue sa vidéo en autoplay muet, mais découpée en éclats irréguliers façon verre brisé — plutôt qu'un simple pourcentage de progression, chaque shard obtenue correspond littéralement à un morceau de la carte qui redevient visible.

Le nombre d'éclats par carte est égal au nombre de shards requis pour son tier (Common = 3, Rare = 6, Epic = 12, Legendary = 24). Les éclats non révélés s'affichent en gris uni (pas de vidéo visible dessous, pas de hachurage). Chaque shard obtenue révèle un éclat supplémentaire en couleur.

Le découpage en éclats de chaque média doit être généré une seule fois et mis en cache par `media_id`, afin que le morcellement reste identique à chaque affichage — sinon la carte donnerait l'impression de se redécouper aléatoirement à chaque chargement plutôt que de représenter une vraie progression. Un algorithme de fracture (type diagramme de Voronoi ou triangulation) génère ce découpage.

Point d'implémentation : le contour entre les éclats doit rester fin (0.5–1px) pour ne pas saturer visuellement les cartes à fort nombre d'éclats (Epic à 12, Legendary à 24 pièces).

### 5.3 Bandeau d'information — trois zones

Sous la vidéo/le puzzle d'éclats, un bandeau séparé par un trait horizontal affiche trois informations réparties en trois zones : points/sec de base du tier à gauche, badge du nom de tier au centre (couleur distincte par tier), multiplicateur de qualité à droite.

## 6. Économie — Dolloss et boosters

Dolloss est la monnaie unique du jeu, alimentée par deux sources :

- La production passive de la collection (`points_per_sec` de toutes les cartes possédées).
- Les shards en doublon (meme déjà débloqué, ou excédent suite à une baisse de tier).

### 6.1 Boosters

> **Révisé post-MVP** (retour utilisateur après la première version) : le modèle initial n'avait qu'un seul type de booster. Il en existe désormais **trois, au choix à l'achat** — moins de shards mais de meilleures cotes en montant en gamme. Chaque tirage de tier reste indépendant (peut tomber sur un média et une rareté différents dans le même booster), et le nom d'un booster ne restreint jamais le tirage à ce tier : un Legendary reste techniquement possible même depuis le booster Common (rare, mais jamais exclu) — contrainte explicite de conception.

| Booster | Shards | Common | Rare | Epic | Legendary |
|---|---|---|---|---|---|
| Common | 5 | 45% | 30% | 18% | 7% |
| Rare | 4 | 25% | 35% | 27% | 13% |
| Epic | 3 | 10% | 25% | 40% | 25% |

Le booster Common reprend la pondération d'origine du MVP (poids volontairement peu sévère sur le Legendary : le seuil de 24 shards requis pour le débloquer suffit déjà à le rendre rare). Les boosters Rare et Epic déplacent progressivement la pondération vers le haut du tableau, sans jamais mettre un poids à zéro.

Voir `economy.BOOSTER_TYPES` dans le repo pour les valeurs exactes utilisées (source de vérité — ce tableau peut dériver si les constantes sont retunées sans mise à jour du doc).

### 6.2 Prix scalant

Le prix de chaque type de booster augmente à chaque achat, formule classique d'idle game — un seul compteur d'achats partagé entre les 3 types (`boosters_purchased_count`), mais un prix de base différent par type :

```
prix(type) = prix_base[type] × taux_croissance ^ (nombre total de boosters déjà achetés, tous types confondus)
```

Avec `taux_croissance = 1.15` et les prix de base `Common = 50`, `Rare = 90`, `Epic = 160` Dolloss : les trois prix montent ensemble à chaque achat (peu importe le type acheté), ce qui évite qu'un joueur puisse indéfiniment n'acheter que le type le moins cher pour éviter l'inflation de prix.

## 7. Schéma de données

Modèle de données minimal proposé pour le MVP, en complément des modèles existants de Memoss (`GameRoom`, `GameRound`, `GameAnswer`, `GameVote`, `GamePlayer`).

- **MemeCard** : `media_id, tier, popularity_score, quality_score, points_per_sec, duration_seconds, updated_at`
- **PlayerCollection** : `account_uid, media_id, shards_owned, shards_required, unlocked (bool)`
- **PlayerCurrency** : `account_uid, dolloss, boosters_purchased_count`
- **ShardLog** : `account_uid, media_id, amount, source ("game_global_rank" | "booster"), game_room_id, created_at`

Le `ShardLog` sert à la fois d'audit et de garde-fou anti-doublon : avant de redistribuer des shards en fin de partie, on vérifie qu'une entrée avec ce `game_room_id` et `source "game_global_rank"` n'existe pas déjà — utile si le job de fin de partie venait à être rejoué.

Le recalcul de `MemeCard` (tier, popularity_score, quality_score, points_per_sec) tourne une fois par jour sur l'ensemble des médias, avec notification des mouvements de tier aux joueurs (voir 2.3).

## 8. Hors scope MVP (repoussé)

- **Prestige** — archivage de collection contre un multiplicateur permanent.
- **Sets / synergies** — bonus pour des memes issus de la même partie, ou par thème/tag.
- **Connexion temps réel** — events live entre la fin d'une partie Memoss et une session Shardoss en cours (ex. boost temporaire "meme du jour").
