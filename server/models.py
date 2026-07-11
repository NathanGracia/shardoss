"""
Modèles SQLModel de Shardoss.

Tiers valides : "common" | "rare" | "epic" | "legendary" — voir economy.py
pour les constantes associées (BASE_POINTS_PER_SEC, SHARDS_REQUIRED).
"""
import datetime
from typing import Optional

from sqlmodel import Field, SQLModel, UniqueConstraint


class MemeCard(SQLModel, table=True):
    __tablename__ = "meme_cards"
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True, unique=True)  # Media.uuid côté Memoss
    tier: str = Field(default="common")
    popularity_score: int = Field(default=0)  # play_count au dernier recalcul
    quality_score: float = Field(default=0.0)  # total_stars/vote_count pondéré
    quality_multiplier: float = Field(default=0.8)
    points_per_sec: float = Field(default=1.0)
    duration_seconds: Optional[float] = Field(default=None)
    shards_required: int = Field(default=3)  # dénormalisé depuis tier
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)


class PlayerCollection(SQLModel, table=True):
    __tablename__ = "player_collection"
    __table_args__ = (UniqueConstraint("account_uid", "media_id", name="uq_player_media"),)
    id: Optional[int] = Field(default=None, primary_key=True)
    account_uid: int = Field(index=True)
    media_id: str = Field(index=True)
    shards_owned: int = Field(default=0)
    shards_required: int = Field(default=3)  # copie rafraîchie au changement de tier
    unlocked: bool = Field(default=False)
    unlocked_at: Optional[datetime.datetime] = Field(default=None)


class PlayerCurrency(SQLModel, table=True):
    __tablename__ = "player_currency"
    account_uid: int = Field(primary_key=True)
    dolloss: float = Field(default=0.0)
    # Un compteur par type de booster (pas un compteur partagé) : le prix
    # d'un pack ne doit monter que pour CE pack acheté, pas pour les 3.
    boosters_purchased_common: int = Field(default=0)
    boosters_purchased_rare: int = Field(default=0)
    boosters_purchased_epic: int = Field(default=0)
    # Joker : shard non liée à un media_id particulier, appliquable sur
    # n'importe quelle carte verrouillée au choix du joueur (achat direct ou
    # loot depuis un booster classique) — voir apply_cooloss_shard() dans
    # economy.py.
    cooloss_shards: int = Field(default=0)
    cooloss_shards_purchased_count: int = Field(default=0)
    last_accrual_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)


class ShardLog(SQLModel, table=True):
    __tablename__ = "shard_log"
    id: Optional[int] = Field(default=None, primary_key=True)
    account_uid: int = Field(index=True)
    media_id: str = Field(index=True)
    amount: int  # peut être négatif pour un ajustement d'audit (ex. tier_shift_excess)
    source: str = Field(index=True)  # "game_global_rank" | "booster" | "cooloss_shard" | "tier_shift_excess"
    game_room_id: Optional[int] = Field(default=None, index=True)
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)


class TierChangeLog(SQLModel, table=True):
    __tablename__ = "tier_change_log"
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True)
    old_tier: Optional[str] = Field(default=None)
    new_tier: str
    direction: str  # "up" | "down"
    occurred_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)


class CardFragments(SQLModel, table=True):
    __tablename__ = "card_fragments"
    media_id: str = Field(primary_key=True)
    tier: str  # tier au moment de la génération, pour détecter le besoin de régénération
    piece_count: int
    polygons_json: str  # JSON: [[[x,y], ...], ...] polygones normalisés 0..1
    reveal_order_json: str  # JSON: [int, ...] ordre de révélation, index de pièce
    generated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)


# Table de loot éditable en admin (voir admin_router.py) — une ligne par
# type de booster. Remplace les constantes figées BOOSTER_TYPES
# d'economy.py, qui ne servent plus que de valeurs de seed au tout premier
# démarrage (voir db.py).
class BoosterConfig(SQLModel, table=True):
    __tablename__ = "booster_config"
    booster_type: str = Field(primary_key=True)  # "common" | "rare" | "epic"
    label: str
    shards: int  # nombre de tirages à l'ouverture de CE booster
    price_base: float
    weight_common: int
    weight_rare: int
    weight_epic: int
    weight_legendary: int


# Réglages globaux de loot hors boosters (shard cooloss) + la courbe de prix
# partagée par les boosters — une seule ligne (id=1, singleton).
class LootSettings(SQLModel, table=True):
    __tablename__ = "loot_settings"
    id: Optional[int] = Field(default=1, primary_key=True)
    booster_price_growth: float = Field(default=1.15)
    cooloss_shard_price_base: float = Field(default=400.0)
    cooloss_shard_price_growth: float = Field(default=1.15)
    cooloss_shard_loot_chance: float = Field(default=0.04)


# Spectre de couleur du toast "+N" affiché à chaque boucle d'une carte
# débloquée — 4 paliers fixes (seuil de gain + couleur hex), éditables en
# admin. Le front choisit le dernier palier dont le seuil est <= au gain
# (paliers triés par seuil croissant). Seuils par défaut calibrés sur
# gain = duration_seconds * points_per_sec (~4 à ~450 en pratique, du
# common courte durée au legendary long et bien noté).
class ToastColorSettings(SQLModel, table=True):
    __tablename__ = "toast_color_settings"
    id: Optional[int] = Field(default=1, primary_key=True)
    stop1_threshold: float = Field(default=0.0)
    stop1_color: str = Field(default="#c9d3da")
    stop2_threshold: float = Field(default=15.0)
    stop2_color: str = Field(default="#ffd75e")
    stop3_threshold: float = Field(default=40.0)
    stop3_color: str = Field(default="#ff9f43")
    stop4_threshold: float = Field(default=100.0)
    stop4_color: str = Field(default="#ff4d8f")
