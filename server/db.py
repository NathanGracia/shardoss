"""
Config, engine SQLModel et migrations — chargés une fois au démarrage,
importés par tous les routers. Suit la même convention que Memoss : colonnes
nouvelles ajoutées via ALTER TABLE dans un bloc try/except au boot plutôt
qu'un framework de migration dédié.
"""
import logging
import os
from typing import Any

import yaml
from sqlmodel import Session, SQLModel, create_engine, text

log = logging.getLogger("shardoss")

CONFIG_PATH = os.environ.get("SHARDOSS_CONFIG", "config.yaml")

_config: dict[str, Any] = {}
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH) as f:
        _config = yaml.safe_load(f) or {}
else:
    log.warning("Pas de %s trouvé — valeurs par défaut vides utilisées.", CONFIG_PATH)


def get_config() -> dict[str, Any]:
    return _config


DB_PATH = _config.get("db_path", "db.sqlite")
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def get_session():
    with Session(engine) as session:
        yield session


def init_db() -> None:
    # Import ici (pas en haut du fichier) pour que SQLModel.metadata connaisse
    # toutes les tables avant create_all — évite un import circulaire avec
    # les routers qui importent get_session/get_config depuis ce module.
    import models  # noqa: F401

    SQLModel.metadata.create_all(engine)

    # Bloc de migrations futures — convention Memoss : un ALTER TABLE par
    # colonne ajoutée après le premier déploiement, dans un try/except qui
    # avale l'erreur "colonne déjà présente".
    # with engine.connect() as _conn:
    #     try:
    #         _conn.execute(text("ALTER TABLE ..."))
    #         _conn.commit()
    #     except Exception:
    #         pass

    # boosters_purchased_count (compteur partagé) remplacé par un compteur
    # par type de booster — l'ancienne colonne reste en base (orpheline,
    # inoffensive) plutôt qu'un DROP destructif.
    with engine.connect() as _conn:
        for _col in ("boosters_purchased_common", "boosters_purchased_rare", "boosters_purchased_epic"):
            try:
                _conn.execute(text(f"ALTER TABLE player_currency ADD COLUMN {_col} INTEGER DEFAULT 0"))
                _conn.commit()
            except Exception:
                pass

    # cooloss_shards : stock de shards jokers (achat direct ou loot booster),
    # applicables sur n'importe quelle carte — voir apply_cooloss_shard().
    with engine.connect() as _conn:
        for _col in ("cooloss_shards", "cooloss_shards_purchased_count"):
            try:
                _conn.execute(text(f"ALTER TABLE player_currency ADD COLUMN {_col} INTEGER DEFAULT 0"))
                _conn.commit()
            except Exception:
                pass
