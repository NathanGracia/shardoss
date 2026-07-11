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
