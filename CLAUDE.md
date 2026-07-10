# CLAUDE.md — Shardoss

## Workflow

**Ne jamais push sans que l'utilisateur le demande explicitement** (la mise en ligne initiale de ce repo fait exception, demandée directement).
**Toujours tester en local avant de push.**

```bash
# Lancer le serveur local
cd server && cp config.yaml.example config.yaml   # puis remplir les valeurs
python main.py
# → http://127.0.0.1:8000 (ou lancer via uvicorn directement, voir Dockerfile)
```

Le serveur local a sa propre DB (`server/db.sqlite`, gitignorée). Ne pas committer `server/config.yaml`, `server/db.sqlite`, `server/shardoss.log`.

## Stack

- **Serveur** : FastAPI + SQLModel (SQLite) + APScheduler (recalcul quotidien) + scipy/shapely (fragments Voronoi)
- **Frontend** : Vanilla JS/CSS SPA — même approche que Memoss/Quizzoss, pas de framework ni d'étape de build
- **Deploy** : Docker Compose sur VPS Ubuntu, CI/CD via GitHub Actions (push main → auto-deploy)

## Rapport avec Memoss

Shardoss est un service **séparé**, avec sa **propre base**, qui communique avec Memoss (`/opt/media-gallery`) par API — pas d'accès direct à la SQLite de Memoss. Voir le plan complet dans les notes de conception (whitepaper + plan d'implémentation) pour le détail des décisions.

- **Memoss → Shardoss** : `POST /api/webhook/game-end`, header `x-shardoss-key`. Appelé en fire-and-forget par Memoss à la fin de chaque partie (`server/shardoss_client.py` côté media-gallery) — une panne de Shardoss ne doit jamais bloquer une partie Memoss.
- **Shardoss → Memoss** : `GET {memoss_base_url}/api/shardoss/stats`, header `x-api-key` (clé dédiée Shardoss dans le `api_keys:` de Memoss, distincte de celle du feeder). Utilisé uniquement par le recalcul quotidien (`recalculation.py`).
- Les deux clés (`memoss_webhook_key`, `memoss_api_key` dans `config.yaml`) sont indépendantes et rotables séparément.
- Le rang utilisé pour la distribution de shards en fin de partie est celui des **légendes** (réponses), pas celui des joueurs — voir les commentaires en tête de `webhook_router.py` avant de toucher à cette logique, la lecture naïve du whitepaper est trompeuse sur ce point.

## Compte partagé (cooloss)

Même contrat que Memoss/Quizzoss — voir `~/docs/compte-unifie-cooloss.md` sur le VPS pour l'architecture complète.

- `server/shared_auth.py` : copie verbatim du vérificateur de Memoss (HMAC-SHA256, `shared_session_secret` dans `config.yaml`, jamais committé). Si le format du token change côté cooloss, ce fichier doit être mis à jour en même temps que les autres implémentations listées dans `compte-unifie-cooloss.md`.
- `GET /api/whoami` : même contrat que Memoss/Quizzoss/Blackjackoss.
- Les invités (pas de session cooloss) n'accumulent **aucune** progression — vérifié côté serveur à chaque écriture (`account_uid` requis), jamais côté client.

## Accrual de Dolloss — piège à éviter

`economy.settle_accrual()` doit être appelé **avant** tout événement qui change la somme des `points_per_sec` d'un compte (déblocage de carte via `apply_shard_grant`, changement de tier dans le batch quotidien) — sinon le nouveau taux s'appliquerait rétroactivement à toute la fenêtre déjà écoulée. `apply_shard_grant()` le fait déjà en interne ; le recalcul quotidien doit le faire explicitement pour chaque compte affecté avant d'écrire les nouveaux `points_per_sec` (voir `recalculation._upsert_card`).

Un `GET` (`/api/collection`, `/api/summary`, `/api/boosters/price`) ne doit **jamais** persister d'accrual — utiliser `economy.live_dolloss_balance()` (lecture pure) plutôt que `settle_accrual()`. Persister sur un GET créerait un risque de double-crédit entre deux requêtes concurrentes.

## Recalcul quotidien

APScheduler in-process (`scheduler.py`), 3h du matin heure de Paris. Nécessite `uvicorn --workers 1` (voir `Dockerfile`) — plusieurs workers feraient tourner le job en double.

`POST /api/admin/recalculate` (session cooloss `isAdmin` requise) déclenche un run manuel — utile pour tester sans attendre 24h.

Le tri par popularité/qualité utilise un **tiebreak stable sur `media_id`** (voir `recalculation.py`) — ne pas le retirer, sans lui les médias ex æquo se réordonnent d'un jour à l'autre et génèrent de faux changements de tier.

## Fragments "verre brisé"

Générés une fois par `media_id` via Voronoi (scipy) + clipping (shapely), mis en cache dans `CardFragments`. Le nombre de pièces est dérivé du tier (`shards_required` au moment de la génération) — si le tier d'un média change, `shatter.get_or_generate_fragments()` détecte le mismatch de `piece_count` et régénère automatiquement.

## Migration DB

Comme Memoss : les nouvelles colonnes s'ajoutent via `ALTER TABLE` dans le bloc try/except de `db.py::init_db()`, pas de framework de migration dédié.

## Versionning du cache frontend

Fichiers statiques référencés avec `?v=N` dans `index.html`. Bumper la version à chaque modification de `app.js`/`style.css` (même piège que Memoss : `StaticFiles` sert avec un cache navigateur, sans bump l'ancienne version reste servie).
