# Shardoss — plan d'implémentation MVP

## Contexte

Shardoss est un nouveau jeu idle/clicker de collection de memes, extension du party-game Memoss existant (`/opt/media-gallery`, memoss.nathangracia.com). Les memes et leur valeur ne sont pas fixés à la main : ils dérivent des statistiques réelles d'usage de Memoss (popularité, qualité des légendes). Whitepaper complet fourni par l'utilisateur, revu et clarifié ci-dessous sur les points ambigus.

Décisions déjà actées avec l'utilisateur :
- **Service séparé avec sa propre base**, communication par API avec Memoss (pas d'accès direct à sa SQLite).
- **Plan d'abord, code ensuite** — ce document doit être approuvé avant toute écriture de code.
- **Maquette Figma/Claude Design inaccessible** (lien 403, authentifié) — le rendu visuel de la section 5 sera implémenté à partir de la description texte du whitepaper, affiné plus tard avec des captures d'écran.

Deux clarifications obtenues de l'utilisateur qui **corrigent** la lecture initiale du whitepaper (importantes, à ne pas re-discuter) :

1. **Le rang utilisé pour les shards est celui des LÉGENDES (réponses), pas celui des joueurs.** Memoss calcule déjà un classement des meilleures légendes en fin de partie (actuellement top 3 fixe, voir `end_game` dans `game_router.py`). La vraie mécanique : on classe **toutes les légendes de la partie** (jusqu'à 3 par joueur, une par round) par qualité (moyenne d'étoiles, puis total d'étoiles en cas d'égalité — même clé de tri que l'existant), on prend les **N meilleures** (N = nombre de joueurs de la partie), et le rang *i* (1-indexé) dans ce top N reçoit `N - i + 1` shards, appliqués **uniquement sur le media_id de cette légende précise** (pas sur les autres medias de la partie). Un joueur avec plusieurs légendes dans le top N est crédité plusieurs fois, sur des medias potentiellement différents. Un joueur dont aucune légende n'entre dans le top N ne reçoit rien cette partie. Les légendes d'invités (`account_uid` NULL) occupent normalement leur rang dans le classement (donc peuvent « consommer » un rang) mais ne génèrent aucune écriture de shard. Ça correspond exactement aux totaux de l'exemple du whitepaper (4 joueurs → 4+3+2+1=10 shards ; 10 joueurs → 55) puisqu'il y a exactement N rangs qualifiants.
2. **Boosters : 5 tirages indépendants**, chacun pondéré par tier séparément — peuvent tomber sur des medias et des raretés différentes (confirmé explicitement par l'utilisateur, pas juste ma recommandation).

## 1. Nouveau service `shardoss`

**Stack** : FastAPI + SQLModel + SQLite — même stack que Memoss/Quizzoss, cohérent avec le reste du VPS (mêmes réflexes ops, même story de déploiement), largement suffisant pour la charge (quelques tables, batch quotidien sur ~200 lignes, quelques dizaines de joueurs).

**Port** : les ports 3001-3010 (agrapart sur 3008, umami sur 3009, confirmés via `lsof`/`docker ps`), 8000, 8010, 8055, 8384, 8501-8503 sont **déjà pris** sur le VPS. **Correction post-plan** : 3009 avait été proposé initialement mais était déjà occupé par `umami` (raté au premier survol, qui ne portait que sur `ss -tlnp` sans croiser `docker ps`) — **port `3011`** retenu pour Shardoss (host) → 8000 (container). Domaine `shardoss.nathangracia.com`.

**Structure** (`/opt/shardoss`, repo `NathanGracia/shardoss`) :
```
shardoss/
  server/
    main.py                # app FastAPI, config, migrations ALTER TABLE, /api/whoami, static mount, CORS
    models.py               # MemeCard, PlayerCollection, PlayerCurrency, ShardLog, TierChangeLog, CardFragments
    shared_auth.py           # copie du vérificateur cooloss (HMAC), même pattern que Memoss/Quizzoss
    memoss_client.py         # httpx: pull GET /api/shardoss/stats sur Memoss
    webhook_router.py        # POST /api/webhook/game-end (Memoss → Shardoss)
    collection_router.py     # GET /api/collection, GET /api/collection/{media_id}/fragments, GET /api/summary (widget Memoss)
    economy_router.py        # GET /api/boosters/prices, POST /api/boosters/buy
    tiers_router.py          # GET /api/tiers/notifications
    economy.py                # apply_shard_grant() partagé (doublon/excédent → Dolloss), accrual
    recalculation.py          # batch quotidien : percentiles → tiers, préservation seuils, TierChangeLog
    scheduler.py               # APScheduler + POST /api/admin/recalculate (isAdmin, pour tests locaux)
    shatter.py                 # génération Voronoi + cache CardFragments
    config.yaml.example
    requirements.txt
    Dockerfile
    docker-compose.yml
    static/  (index.html, app.js, shatter.js, style.css, account-widget.js)
  .github/workflows/deploy.yml
  CLAUDE.md
```

**Auth cooloss** : contrat identique à Memoss — `shared_auth.py`, `GET /api/whoami`, `shared_session_secret` dans `config.yaml`. Consigné dans `~/docs/compte-unifie-cooloss.md` comme 8e implémentation.

**Auth service-à-service (deux clés distinctes, rotables indépendamment)** :
- **Memoss → Shardoss** (webhook) : header `x-shardoss-key`, vérifié par une dépendance `require_memoss_key` dans `webhook_router.py`, valeur dans `config.yaml` de Shardoss.
- **Shardoss → Memoss** (pull stats) : réutilise le mécanisme `require_api_key` déjà existant côté Memoss (`API_KEYS = set(cfg.get("api_keys", []))`) — on ajoute juste une clé dédiée Shardoss dans `api_keys:` du `config.yaml` de Memoss. **Zéro nouveau code d'auth côté Memoss pour ce sens.**

## 2. Changements côté Memoss (`/opt/media-gallery`)

**`server/main.py`** :
- `Media.duration_seconds: Optional[float] = Field(default=None)`.
- Migration `ALTER TABLE media ADD COLUMN duration_seconds FLOAT` dans le bloc try/except existant (convention documentée dans `CLAUDE.md`).
- `gen_video_duration(src: Path) -> Optional[float]` via `ffprobe -v error -show_entries format=duration -of csv=p=0` (ffmpeg déjà dans l'image Docker, utilisé par `gen_video_thumb`). Appelé dans `upload()` pour `media_type == "video"`, à côté de `gen_video_thumb`.
- Script one-shot `server/scripts/backfill_duration.py` pour les ~200 médias déjà en base (exécuté manuellement une fois via `docker compose exec`, pas à chaque démarrage).
- Nouvel endpoint `GET /api/shardoss/stats` (gated `require_api_key`) : population **complète** `tag='cinema' AND media_type='video'` (y compris médias à 0 vue — nécessaire pour des percentiles corrects sur toute la galerie), avec `uuid, duration_seconds, play_count (COUNT GameAnswer), total_stars_sum, vote_count_sum` via agrégation SQL similaire à celle déjà utilisée dans `list_media`.

**`server/game_router.py`** :
- Nouveau module `shardoss_client.py` : `notify_shardoss(payload)` en `httpx.AsyncClient` (nouvelle dépendance — `requests` est synchrone et bloquerait la boucle asyncio partagée par toutes les rooms), timeout court (~3s), try/except qui avale toute exception et logue un warning. No-op silencieux si `SHARDOSS_BASE_URL` n'est pas configuré (dev sans Shardoss).
- Dans `end_game(code)`, juste après `await _save_to_db(code)` : construire le payload et faire `asyncio.create_task(notify_shardoss(payload))` — **jamais awaité, jamais bloquant**. Une panne de Shardoss ne doit jamais impacter une partie Memoss en cours (test de non-régression explicite en section Vérification).
- Payload, construit à partir de `state["all_answers"]` (déjà en mémoire, contient tout ce qu'il faut) :
  ```json
  {
    "game_room_id": 123,
    "player_count": 4,
    "legends": [
      {"account_uid": 5, "media_id": "uuid-a", "total_stars": 18, "vote_count": 4},
      {"account_uid": null, "media_id": "uuid-b", "total_stars": 6, "vote_count": 2}
    ]
  }
  ```
  Une entrée par `GameAnswer` de toute la partie (jusqu'à 3 par joueur), `account_uid` gardé même NULL (invité) — c'est Shardoss qui décide de ne pas créditer, pas Memoss qui filtre en amont (garde le classement des rangs cohérent même si un invité occupe un rang).
- Pas de retry côté Memoss (best-effort) — la ré-émission sûre est entièrement gérée côté Shardoss via `ShardLog`.
- Rien à changer sur `players_list()` ni sur la logique d'affichage "top 3 légendes" existante (comportement Memoss inchangé) — le classement pour les shards est recalculé indépendamment côté Shardoss à partir de la liste complète des légendes envoyées.

## 3. Modèle de données Shardoss

```python
class MemeCard(SQLModel, table=True):
    __tablename__ = "meme_cards"
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True, unique=True)          # Media.uuid de Memoss
    tier: str = Field(default="common")                      # common|rare|epic|legendary
    popularity_score: int = Field(default=0)                 # play_count au dernier recalcul
    quality_score: float = Field(default=0.0)                # total_stars/vote_count pondéré
    quality_multiplier: float = Field(default=0.8)
    points_per_sec: float = Field(default=1.0)
    duration_seconds: Optional[float] = Field(default=None)
    shards_required: int = Field(default=3)                  # dénormalisé depuis tier
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

class PlayerCollection(SQLModel, table=True):
    __tablename__ = "player_collection"
    id: Optional[int] = Field(default=None, primary_key=True)
    account_uid: int = Field(index=True)
    media_id: str = Field(index=True)
    shards_owned: int = Field(default=0)
    shards_required: int = Field(default=3)                   # copie rafraîchie au changement de tier
    unlocked: bool = Field(default=False)
    unlocked_at: Optional[datetime.datetime] = Field(default=None)
    __table_args__ = (UniqueConstraint("account_uid", "media_id", name="uq_player_media"),)

class PlayerCurrency(SQLModel, table=True):
    __tablename__ = "player_currency"
    account_uid: int = Field(primary_key=True)
    dolloss: float = Field(default=0.0)
    boosters_purchased_count: int = Field(default=0)
    last_accrual_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

class ShardLog(SQLModel, table=True):
    __tablename__ = "shard_log"
    id: Optional[int] = Field(default=None, primary_key=True)
    account_uid: int = Field(index=True)
    media_id: str = Field(index=True)
    amount: int
    source: str                                                # game_global_rank|booster|tier_shift_excess
    game_room_id: Optional[int] = Field(default=None, index=True)
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

# Additions au-delà du schéma minimal du whitepaper (§7 dit "en complément" — extensions attendues)
class TierChangeLog(SQLModel, table=True):
    __tablename__ = "tier_change_log"
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str
    old_tier: Optional[str] = Field(default=None)
    new_tier: str
    direction: str                                              # "up" | "down"
    occurred_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

class CardFragments(SQLModel, table=True):
    __tablename__ = "card_fragments"
    media_id: str = Field(primary_key=True)
    tier: str                                                    # tier au moment de la génération (staleness check)
    piece_count: int
    polygons_json: str                                           # JSON [[[x,y],...], ...] normalisé 0..1
    reveal_order_json: str                                        # ordre de révélation, shard N révèle reveal_order[N-1]
    generated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
```

**Garde-fou anti-doublon de `ShardLog`** : avant tout traitement d'un webhook, `SELECT 1 FROM shard_log WHERE game_room_id = :id AND source = 'game_global_rank' LIMIT 1`. Si trouvé → `{"ok": true, "skipped": "already_processed"}`, zéro écriture. Tout le traitement d'un webhook se fait dans **une seule transaction** (un seul commit final) — un crash en cours de traitement ne peut jamais laisser un état partiel pendant que la garde dirait "déjà traité" ; un replay verrait "pas encore traité" et rejouerait proprement l'ensemble.

## 4. Distribution de shards en fin de partie (corrigé)

`POST /api/webhook/game-end`, header `x-shardoss-key` :
1. `require_memoss_key` valide le header.
2. Idempotence : check `game_room_id` (section 3) — court-circuite si déjà traité.
3. Trier `legends` par `(total_stars/vote_count si vote_count else 0, total_stars)` décroissant — même clé de tri que le top-3 existant de Memoss, juste étendue à tout `player_count` au lieu de 3 fixe.
4. Prendre les `player_count` premières entrées. Pour l'entrée à l'index `i` (0-indexé) : `shard_amount = player_count - i`.
5. Si `account_uid` est `None` (invité) → aucune écriture, le rang est simplement "consommé" (moins de shards distribuées cette partie si un invité performe bien).
6. Sinon, pour ce `(account_uid, media_id, shard_amount)` :
   - `settle_accrual(account_uid)` d'abord (voir section 7) — un déblocage va changer Σpoints_per_sec, l'accrual écoulé doit être settlé à l'ancien taux avant.
   - Récupérer (ou créer avec des valeurs par défaut `tier=common, shards_required=3`, corrigées au prochain recalcul quotidien) le `MemeCard`.
   - Upsert `PlayerCollection` : `applied = min(shard_amount, max(shards_required - shards_owned, 0))`, `overflow = shard_amount - applied`.
   - `shards_owned += applied` ; si atteint `shards_required` → `unlocked = True` (+ `unlocked_at` si pas déjà défini).
   - `overflow > 0` (carte déjà débloquée, ou grant qui dépasse la marge restante) → `PlayerCurrency.dolloss += overflow`.
   - Toujours logger `ShardLog(account_uid, media_id, amount=shard_amount, source="game_global_rank", game_room_id)` — l'entitlement brut, pour audit, indépendamment de combien a été effectivement appliqué/converti.
7. Un seul commit final. Retour `{"ok": true, "processed": <n>}`.

La conversion doublon/excédent → Dolloss est factorisée dans un helper partagé `apply_shard_grant()` (`server/economy.py`), réutilisé ici, dans le batch quotidien (tier down, section 5) et dans les boosters (section 6) — un seul endroit possède "que se passe-t-il quand un grant de shards dépasse la marge restante".

## 5. Recalcul quotidien

**Ordonnancement — APScheduler in-process**, pas de cron hôte (aucune app existante sur ce VPS n'a de pattern cron à réutiliser ; in-process garde `docker compose up` comme story de déploiement unique, cohérent avec toutes les autres apps, et réutilise directement la session SQLModel + le client Memoss déjà câblés).
```python
scheduler = AsyncIOScheduler(timezone="Europe/Paris")
scheduler.add_job(run_daily_recalculation, "cron", hour=3, minute=0, id="daily_recalc", misfire_grace_time=3600)
```
Démarré dans le lifespan FastAPI. Plus `POST /api/admin/recalculate` (gated `isAdmin` cooloss) pour déclencher manuellement — indispensable pour tester en local sans attendre 24h. **Contrainte : `uvicorn --workers 1` dans le Dockerfile** (comme Memoss, vérifié) — plusieurs workers feraient tourner le job APScheduler en double.

**Calcul percentile → tier** (`recalculation.py`) :
1. Pull `GET /api/shardoss/stats` — population complète (y compris médias à 0 vue, nécessaire pour des percentiles corrects sur toute la galerie).
2. Trier par `(play_count DESC, media_id)` — le **tiebreak stable sur `media_id` est obligatoire** : avec ~200 médias dont beaucoup à égalité (notamment les 0 vue), un tri instable réordonnerait les ex æquo d'un jour à l'autre → changements de tier fantômes aux frontières de percentile + fausses notifications quotidiennes. Pour l'item à l'index trié `i` (0-indexé) sur `M` total, `pct = i / M`. `pct < 0.05` → legendary, `< 0.20` → epic, `< 0.50` → rare, sinon common (cumulatif top 5/15/30/50, conforme au whitepaper).
3. `quality_score = total_stars_sum / vote_count_sum si vote_count_sum else 0`.
4. **À l'intérieur de chaque tier**, percentile de qualité (même tiebreak stable `media_id`), puis `quality_multiplier = 0.8 + quality_pct * 0.7` (interpolation linéaire sur la plage 0.8–1.5 donnée par le whitepaper — la courbe exacte n'est pas spécifiée, ce paramètre est facilement ajustable plus tard si le ressenti de jeu ne convient pas).
5. `points_per_sec = BASE[tier] * quality_multiplier`, `BASE = {common:1, rare:3, epic:6, legendary:10}` ; `shards_required = {common:3, rare:6, epic:12, legendary:24}[tier]`.
6. **Avant d'écrire les nouveaux `points_per_sec`** : `settle_accrual` (section 7) pour chaque joueur ayant au moins une carte débloquée dont le pps change — l'accrual écoulé se settle à l'ancien taux, les nouveaux taux ne s'appliquent qu'à partir de maintenant. Puis upsert `MemeCard`. Si `old_tier != new_tier` → `TierChangeLog`.
   - **Montée de tier** : les `PlayerCollection` déjà `unlocked=True` restent inchangées (déblocage acquis préservé). Pour les non-débloquées sur ce media, rafraîchir `shards_required` au nouveau seuil (plus élevé).
   - **Descente de tier** : pour chaque `PlayerCollection` où `shards_owned > new_required` : `excess = shards_owned - new_required` ; `shards_owned = new_required` ; `unlocked = True` ; créditer `PlayerCurrency.dolloss += excess` via `apply_shard_grant`, logger `ShardLog(source="tier_shift_excess")`.
7. Une seule transaction pour tout le run — le recalcul du jour est atomique.

**Notifications de mouvement de tier** (différé temps-réel, §8 du whitepaper) — polling pur : `GET /api/tiers/notifications?since_id=<int>` retourne `{latest_id, changes: [...]}` — les lignes `TierChangeLog` avec `id > since_id`, filtrées côté serveur aux médias que la collection de l'appelant possède réellement (les mouvements sur des cartes jamais touchées sont ignorés). Curseur suivi **côté client** (`localStorage`), pas d'état de lecture par joueur côté serveur — le plus simple, cohérent avec le scope MVP sans temps réel. **Première visite (pas de curseur en localStorage)** : le client appelle sans `since_id`, le serveur ne retourne que `latest_id` sans `changes` — le client initialise son curseur silencieusement au lieu de recevoir tout l'historique d'un coup.

## 6. Fragments Voronoi (verre brisé)

- **Lib** : `scipy.spatial.Voronoi` pour les cellules + `shapely` pour clipper les cellules non bornées contre `box(0,0,1,1)`. Le serveur est la seule source de vérité géométrique, le client se contente de peindre.
- **Détermination** : points de seed générés par un PRNG seedé sur `media_id` (`random.Random(media_id)`) — reproductible même sans cache, mais le whitepaper (§5.2) exige explicitement un cache par `media_id`, donc persisté dans `CardFragments` pour éviter de recalculer Voronoi+clipping à chaque chargement.
- **Nombre de pièces** = `shards_required` du tier au moment de la génération (3/6/12/24). Polygones stockés normalisés `[0,1]×[0,1]`, corrigés à l'aspect-ratio réel côté client.
- **Ordre de révélation** : généré une fois via le même PRNG seedé, stocké (`reveal_order_json`). Pièce `reveal_order[k]` visible dès que `shards_owned > k`. Partagé entre tous les joueurs possédant ce media (pas par joueur) — plus simple, rien dans le spec ne demande une randomisation par joueur.
- **Invalidation de cache** : `GET /api/collection/{media_id}/fragments` compare `CardFragments.piece_count` au `MemeCard.shards_required` courant ; mismatch (tier changé depuis la dernière génération) → régénération ponctuelle.
- **Rendu** : un `<svg>` par carte, un `<polygon>` par pièce, pièces non révélées en gris opaque (pas de vidéo visible dessous, pas de hachurage), contour 0.5–1px sur toutes les pièces.

## 7. Boosters

> **Révisé post-MVP** : 3 produits au choix (`economy.BOOSTER_TYPES`), pas un seul générique — voir whitepaper §6.1 pour le tableau des poids/prix. `GET /api/boosters/prices` (pluriel) retourne les 3 en une fois : `{common: {label, shards, price}, rare: {...}, epic: {...}}`.

`GET /api/boosters/prices` → pour chaque type, `price_base[type] * 1.15 ** boosters_purchased_count` (compteur d'achats partagé entre les 3 types).

`POST /api/boosters/buy` (body `{"booster_type": "common"|"rare"|"epic"}`) :
1. Session cooloss requise (invités ne peuvent pas acheter).
2. 400 si `booster_type` invalide.
3. Accrual paresseux du solde avant de vérifier (voir accrual ci-dessous).
4. Prix recalculé côté serveur pour ce type (jamais un prix envoyé par le client) ; 402 si solde insuffisant.
5. Débit du prix, incrément `boosters_purchased_count` (partagé, affecte le prix des 3 types au prochain achat).
6. **N tirages indépendants** (N = `shards` du type acheté, 5/4/3) : `random.choices([...], weights=BOOSTER_TYPES[type]["weights"], k=N)` — chaque tirage peut tomber sur un tier/media différent, y compris un tier au-dessus ou en-dessous du "thème" du booster acheté (aucun poids à zéro dans aucune table, un Legendary reste toujours techniquement tirable même depuis un booster Common).
7. Par tirage : media aléatoire dans ce tier (`ORDER BY RANDOM() LIMIT 1`, correct à ~200 lignes), repli sur le tier non-vide le plus proche si le tier tiré est momentanément vide, `apply_shard_grant(..., amount=1, source="booster")`.
8. Commit ; retour `{"ok": true, "dolloss": <solde>, "booster_type": <type>, "results": [{"media_id", "tier", "shard_applied": 1, "overflow_to_dolloss": ...}, ...]}` pour une animation de révélation par carte.

**Accrual passif** (`PlayerCurrency`) : paresseux, pas de boucle de tick serveur. Fonction unique `settle_accrual(account_uid, now)` dans `economy.py` : `dolloss += (now - last_accrual_at).total_seconds() * sum(points_per_sec des cartes débloquées)`, puis `last_accrual_at = now`. C'est ce qui rend les gains hors-ligne (§5.1) corrects gratuitement. Deux règles de correction importantes :

- **Settler AVANT tout événement qui modifie Σpoints_per_sec** : au début du traitement d'un webhook game-end et d'un achat de booster (avant que `apply_shard_grant` ne débloque une carte), et dans le batch quotidien pour chaque joueur dont au moins une carte débloquée change de `points_per_sec` (settler au vieux taux avant d'écrire les nouveaux). Sinon un déblocage ou un recalcul appliquerait rétroactivement le nouveau taux à toute la fenêtre écoulée depuis `last_accrual_at`.
- **`GET /api/collection` ne mute rien** : le solde affiché est calculé à la volée (`dolloss stocké + elapsed × Σpps`) sans écriture. Persister l'accrual sur un GET créerait un risque de double crédit entre deux requêtes concurrentes (les deux lisent le même `last_accrual_at`) et violerait l'idempotence des lectures. L'écriture n'a lieu qu'aux points de mutation existants (webhook, booster, batch) — entre deux mutations, le solde à la volée reste exact puisque Σpps est constant sur la fenêtre.

## 8. Frontend

**Vanilla JS/CSS SPA**, cohérent avec Memoss/Quizzoss (tous les FastAPI "-oss" du VPS sont vanilla, `StaticFiles` + `?v=N`, pas d'étape de build). La complexité réelle (grille de cartes + overlay SVG + quelques boutons) ne justifie pas un framework.

Fichiers : `static/index.html` (header avec account-widget + barre d'économie, grille de cartes), `static/app.js` (fetch `/api/whoami`, `/api/collection`, fragments par carte ; compteur "pop" piloté par les events `loadedmetadata`/`ended` de **chaque vidéo individuellement** par §5.1, pas un tick global ; handler boosters ; poll notifications de tier toutes les 60s), `static/style.css` (DA §1.1 — fond `#16121F`, cartes `#F3E9D8`, accent `#E14953`, couleurs de tier, police mono type `"JetBrains Mono"` pour les compteurs), `static/shatter.js` (rendu overlay SVG depuis les données de fragments).

**Toggle opt-in côté Memoss** : nouveau `server/static/shardoss-widget.js` dans `/opt/media-gallery`, sur le modèle de `account-widget.js` (module partagé inclus par chaque page). Flag opt-in `localStorage` (off par défaut) ; si activé, `fetch()` cross-origin direct vers `https://shardoss.nathangracia.com/api/summary` (pas de proxy via le backend Memoss — garde l'API Shardoss autonome), nécessite `CORSMiddleware` sur Shardoss scopé à `https://memoss.nathangracia.com` avec credentials (même domaine parent, cookie déjà partagé). Inclus via `<div id="shardoss-widget"></div>` + `<script>` versionné dans `index.html`, `timeline.html`, `game/index.html`.

## 9. Ordre de build (7 étapes, chacune testable indépendamment)

0. **Scaffolding** — repo, compose, vhost nginx, SSL, `/api/whoami`, tables vides. **Prérequis manuel** : créer l'enregistrement DNS A `shardoss.nathangracia.com` → `141.227.165.46` avant de lancer certbot (même procédure que quizzoss dans `ARCHITECTURE.md`). *Test* : login cooloss sur shardoss.nathangracia.com.
1. **Pont stats Memoss** — `duration_seconds` + ffprobe + backfill + `GET /api/shardoss/stats`, pas encore de logique Shardoss. *Test* : curl l'endpoint, vérifier les comptes contre l'historique de parties connu.
2. **Modèle de données + recalcul manuel** — `MemeCard`/`TierChangeLog` + `recalculation.py` + `POST /api/admin/recalculate` (pas de scheduler, pas de webhook). *Test* : déclenchement manuel, vérifier tiers/points_per_sec calculés à la main.
3. **Webhook + distribution de shards** — `ShardLog`/`PlayerCollection`/`PlayerCurrency` + `webhook_router.py` + le hook `end_game` côté Memoss. *Test* : jouer une vraie partie locale avec 2+ comptes connectés + 1 invité, vérifier les shards et l'exclusion de l'invité ; rejouer le même payload en curl, confirmer l'absence de doublon (idempotence).
4. **Économie idle (JSON seul)** — formule d'accrual + `GET /api/collection`, pas de visuel. *Test* : fetch avant/après une attente, vérifier que le delta de dolloss correspond à `temps écoulé × Σpoints_per_sec`.
5. **Boosters** — endpoints achat/prix réutilisant `apply_shard_grant`. *Test* : vérifier le scaling de prix, la distribution pondérée sur de nombreux tirages, la conversion doublon une fois une carte maxée.
6. **Visuels verre brisé + page collection** — `shatter.py`/`CardFragments` + frontend complet. *Test* : confirmer visuellement les comptes de fragments Common(3)/Legendary(24), stabilité du cache entre rechargements, comportement gris-non-révélé/vidéo-révélée.
7. **Scheduling batch quotidien + notifications de tier + widget Memoss** — en dernier (le moins risqué/le plus différable). *Test* : forcer un changement de tier avec des données fixture, confirmer `TierChangeLog`, préservation de seuil, endpoint/widget de notification.

Cet ordre reporte tout le travail dépendant du visuel/de la maquette (étape 6) après que toute l'économie backend soit prouvée correcte via curl/inspection DB — minimise le travail à refaire une fois les vraies captures d'écran disponibles.

## 10. Vérification

- Lancer les deux services en local comme documenté dans chaque `CLAUDE.md` (`cd server && python main.py`), Memoss sur 8000, Shardoss sur un port local distinct (ex. 8001), chacun configuré pour pointer vers l'autre en `127.0.0.1`, partageant le même `shared_session_secret`. Pour une session de test connectée sans monter cooloss aussi : signer HMAC un payload de claims factice localement avec le secret partagé (format documenté et stateless-vérifiable), le poser via curl `-b`/devtools.
- Semer Memoss local avec quelques entrées vidéo `tag=cinema` (upload via `x-api-key` du feeder).
- Jouer une partie complète à 3 rounds sur 2-4 sessions locales (mix connectés + 1 invité), puis inspecter `db.sqlite` de Shardoss pour les comptes de shards par joueur/média corrects et confirmer que l'invité produit zéro ligne.
- Idempotence : logger le JSON du webhook sortant en INFO dans `notify_shardoss`, le rejouer en curl, confirmer que les comptes de lignes sont inchangés.
- Batch quotidien : lancer `POST /api/admin/recalculate` sur un petit jeu de fixtures (10-20 médias) où les percentiles/tiers attendus sont calculables à la main.
- Mouvement de tier : ajuster manuellement le `play_count` simulé d'un média seedé (ou monkeypatcher la réponse stats), relancer le recalcul, confirmer `TierChangeLog` + comportement de préservation de seuil/conversion d'excédent pour un joueur positionné délibérément à la frontière (via SQL direct).
- Test de fumée frontend sur le compte qui vient de jouer la partie simulée — rendu des cartes, nombre de pièces de fragmentation, bandeau 3 zones, mise à jour visuelle à l'achat de booster.
- **Test de non-régression critique** : tuer le process Shardoss local, puis jouer une partie Memoss — confirmer que `end_game`/`_save_to_db`/broadcast `game_end` ne sont absolument pas affectés, seul un warning est loggé. C'est le test le plus important vu l'exigence explicite de non-blocage.

### Fichiers critiques
- `/opt/media-gallery/server/game_router.py` (hook `end_game`, `_save_to_db`)
- `/opt/media-gallery/server/main.py` (`Media.duration_seconds`, `GET /api/shardoss/stats`)
- `/opt/shardoss/server/models.py`
- `/opt/shardoss/server/webhook_router.py`
- `/opt/shardoss/server/recalculation.py`
- `/opt/shardoss/server/shatter.py`
