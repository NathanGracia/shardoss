# Shardoss

Jeu idle/clicker de collection de memes, extension du party-game [Memoss](https://memoss.nathangracia.com). Les memes collectionnés et leur valeur ne sont pas fixés à la main : ils dérivent des statistiques d'usage réelles de Memoss (popularité des médias, qualité des légendes reçues).

- **Whitepaper** (conception produit) : [`docs/whitepaper.md`](docs/whitepaper.md)
- **Plan d'implémentation** (architecture, modèle de données, ordre de build) : [`docs/plan.md`](docs/plan.md)
- **Conventions de dev** : [`CLAUDE.md`](CLAUDE.md)

## Stack

FastAPI + SQLModel (SQLite) + APScheduler côté serveur, vanilla JS/CSS côté client — même approche que les autres apps "-oss" du VPS (Memoss, Quizzoss). Service **séparé** de Memoss, avec sa propre base, communiquant par API (webhook en fin de partie, pull de stats pour le recalcul quotidien).

## Démarrage local

```bash
cd server
cp config.yaml.example config.yaml   # remplir shared_session_secret, memoss_base_url, memoss_api_key, memoss_webhook_key
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

Nécessite une instance Memoss locale ou distante joignable (voir `memoss_base_url`) pour le recalcul quotidien et le webhook de fin de partie — le reste (collection, boosters) fonctionne avec juste `db.sqlite`.

## Déploiement

Docker Compose, port `3011` (host) → `8000` (container), domaine `shardoss.nathangracia.com`. CI/CD via GitHub Actions (`.github/workflows/deploy.yml`) : push sur `main` → SSH → `docker compose up -d --build`.
