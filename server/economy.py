"""
Logique économique partagée : constantes de balance, accrual paresseux de
Dolloss, et l'unique point d'entrée pour créditer des shards (garantit que
"que se passe-t-il quand un grant dépasse la marge restante" n'est écrit
qu'une fois — réutilisé par webhook_router, economy_router (boosters) et
recalculation (descente de tier)).
"""
import datetime
import json
from typing import Optional

from sqlmodel import Session, func, select

from models import BoosterConfig, LootSettings, MemeCard, PlayerCollection, PlayerCurrency, ShardLog

BASE_POINTS_PER_SEC = {"common": 1.0, "rare": 3.0, "epic": 6.0, "legendary": 10.0}
SHARDS_REQUIRED = {"common": 3, "rare": 6, "epic": 12, "legendary": 24}
QUALITY_MULTIPLIER_MIN = 0.8
QUALITY_MULTIPLIER_MAX = 1.5

# Les constantes ci-dessous (BOOSTER_PRICE_GROWTH, BOOSTER_TYPES,
# COOLOSS_SHARD_*) ne sont PLUS la source de vérité en runtime — elles ne
# servent qu'à SEEDER les tables BoosterConfig/LootSettings au tout premier
# démarrage (voir db.py, init_db). La logique métier lit toujours la DB
# (via get_loot_settings/get_booster_config ci-dessous), modifiable en live
# depuis /api/admin/loot-config sans redéploiement.
BOOSTER_PRICE_GROWTH = 1.15  # appliqué au prix de base de CHAQUE type, sur SON PROPRE compteur d'achats

# Trois produits de booster au choix (achat, pas juste ouverture) : moins de
# shards mais de meilleures cotes à mesure qu'on monte en gamme — le nom du
# booster ("epic") n'exclut jamais les autres tiers du tirage, il déplace
# juste la pondération. Le tier "common" du tirage reste toujours possible
# même sur le booster "epic", et inversement le legendary reste toujours
# techniquement possible même sur le booster "common" (juste rare) —
# contrainte explicite de l'utilisateur, pas un oubli.
BOOSTER_TYPES = {
    "common": {
        "label": "Common",
        "shards": 5,
        "price_base": 50.0,
        "weights": {"common": 45, "rare": 30, "epic": 18, "legendary": 7},
    },
    "rare": {
        "label": "Rare",
        "shards": 4,
        "price_base": 90.0,
        "weights": {"common": 25, "rare": 35, "epic": 27, "legendary": 13},
    },
    "epic": {
        "label": "Epic",
        "shards": 3,
        "price_base": 160.0,
        "weights": {"common": 10, "rare": 25, "epic": 40, "legendary": 25},
    },
}

# Cumulatif, dans cet ordre — cf. whitepaper §2.1 (top 5% / 15% suivants / 30% suivants / reste)
TIER_PERCENTILE_CUTOFFS = [("legendary", 0.05), ("epic", 0.20), ("rare", 0.50)]


def tier_for_percentile(pct: float) -> str:
    for tier, cutoff in TIER_PERCENTILE_CUTOFFS:
        if pct < cutoff:
            return tier
    return "common"


def get_or_create_meme_card(session: Session, media_id: str) -> MemeCard:
    card = session.exec(select(MemeCard).where(MemeCard.media_id == media_id)).first()
    if card is None:
        card = MemeCard(
            media_id=media_id,
            tier="common",
            shards_required=SHARDS_REQUIRED["common"],
            quality_multiplier=QUALITY_MULTIPLIER_MIN,
            points_per_sec=BASE_POINTS_PER_SEC["common"] * QUALITY_MULTIPLIER_MIN,
        )
        session.add(card)
        session.flush()
    return card


def get_or_create_collection(
    session: Session, account_uid: int, media_id: str, card: Optional[MemeCard] = None
) -> PlayerCollection:
    coll = session.exec(
        select(PlayerCollection).where(
            PlayerCollection.account_uid == account_uid, PlayerCollection.media_id == media_id
        )
    ).first()
    if coll is None:
        card = card or get_or_create_meme_card(session, media_id)
        coll = PlayerCollection(
            account_uid=account_uid,
            media_id=media_id,
            shards_owned=0,
            shards_required=card.shards_required,
            unlocked=False,
        )
        session.add(coll)
        session.flush()
    return coll


def get_or_create_currency(session: Session, account_uid: int) -> PlayerCurrency:
    currency = session.get(PlayerCurrency, account_uid)
    if currency is None:
        currency = PlayerCurrency(account_uid=account_uid)
        session.add(currency)
        session.flush()
    return currency


def sum_points_per_sec(session: Session, account_uid: int) -> float:
    stmt = (
        select(func.sum(MemeCard.points_per_sec))
        .select_from(PlayerCollection)
        .join(MemeCard, MemeCard.media_id == PlayerCollection.media_id)
        .where(PlayerCollection.account_uid == account_uid, PlayerCollection.unlocked == True)  # noqa: E712
    )
    total = session.exec(stmt).one()
    return total or 0.0


def settle_accrual(
    session: Session, account_uid: int, now: Optional[datetime.datetime] = None
) -> PlayerCurrency:
    """
    Règle le Dolloss accumulé depuis last_accrual_at au taux (Σpoints_per_sec)
    qui était valable jusqu'ici, puis avance le curseur à `now`. À appeler
    AVANT tout événement qui change Σpoints_per_sec pour un compte (un
    déblocage de carte, un changement de tier) — sinon le nouveau taux
    s'appliquerait rétroactivement à la fenêtre déjà écoulée.
    """
    now = now or datetime.datetime.utcnow()
    currency = get_or_create_currency(session, account_uid)
    elapsed = (now - currency.last_accrual_at).total_seconds()
    if elapsed > 0:
        currency.dolloss += elapsed * sum_points_per_sec(session, account_uid)
    currency.last_accrual_at = now
    session.add(currency)
    return currency


def live_dolloss_balance(
    session: Session, account_uid: int, now: Optional[datetime.datetime] = None
) -> float:
    """
    Lecture pure du solde de Dolloss, accrual inclus, sans rien écrire — pour
    les endpoints GET (§7 du plan : un GET ne doit jamais persister d'accrual,
    ça créerait un risque de double-crédit entre requêtes concurrentes).
    """
    now = now or datetime.datetime.utcnow()
    currency = session.get(PlayerCurrency, account_uid)
    if currency is None:
        return 0.0
    elapsed = max((now - currency.last_accrual_at).total_seconds(), 0.0)
    return currency.dolloss + elapsed * sum_points_per_sec(session, account_uid)


def apply_shard_grant(
    session: Session,
    account_uid: int,
    media_id: str,
    amount: int,
    source: str,
    game_room_id: Optional[int] = None,
) -> dict:
    """
    Crédite `amount` shards de `media_id` à `account_uid`, en clippant à la
    marge restante avant le seuil de déblocage et en convertissant tout
    dépassement en Dolloss (doublon / carte déjà débloquée). Loggue toujours
    une ligne ShardLog avec l'entitlement brut, indépendamment de combien a
    été effectivement appliqué. Ne commit pas — au caller de gérer la
    transaction.
    """
    now = datetime.datetime.utcnow()
    settle_accrual(session, account_uid, now)  # avant un déblocage éventuel qui changerait Σpps

    card = get_or_create_meme_card(session, media_id)
    coll = get_or_create_collection(session, account_uid, media_id, card)

    # Récupéré ici, avant toute mutation de CET appel : get_or_generate_fragments
    # commit en interne au premier appel pour un media_id donné (cache miss) —
    # appelé plus tard dans la fonction, ce commit couperait en deux la
    # transaction de ce grant (coll persisté sans currency/ShardLog si un
    # crash survient entre les deux). Import différé (pas en tête de fichier)
    # : évite un cycle, shatter.py n'a pas besoin de connaître economy.py.
    from shatter import get_or_generate_fragments

    fragments = get_or_generate_fragments(session, media_id, card.tier, card.shards_required)
    reveal_order = json.loads(fragments.reveal_order_json)
    polygons = json.loads(fragments.polygons_json)

    remaining = max(coll.shards_required - coll.shards_owned, 0)
    applied = min(amount, remaining)
    overflow = amount - applied

    shards_owned_before = coll.shards_owned
    coll.shards_owned += applied
    newly_unlocked = False
    if coll.shards_owned >= coll.shards_required and not coll.unlocked:
        coll.unlocked = True
        coll.unlocked_at = now
        newly_unlocked = True
    session.add(coll)

    # Le polygone du/des éclat(s) qui vien(nen)t de passer de non-révélé à
    # révélé — pour que le front puisse montrer, avant même le clic de
    # révélation dans l'UI d'ouverture de booster, la vraie silhouette de
    # l'éclat qui va apparaître sur la carte plutôt qu'un losange générique.
    newly_revealed_points = None
    for k in range(shards_owned_before, coll.shards_owned):
        if k < len(reveal_order):
            newly_revealed_points = polygons[reveal_order[k]]

    if overflow > 0:
        currency = get_or_create_currency(session, account_uid)
        currency.dolloss += overflow
        session.add(currency)

    session.add(
        ShardLog(
            account_uid=account_uid,
            media_id=media_id,
            amount=amount,
            source=source,
            game_room_id=game_room_id,
            created_at=now,
        )
    )

    return {
        "media_id": media_id,
        "tier": card.tier,
        "points_per_sec": card.points_per_sec,
        "quality_multiplier": card.quality_multiplier,
        "shard_applied": applied,
        "overflow_to_dolloss": overflow,
        "unlocked": coll.unlocked,
        "newly_unlocked": newly_unlocked,
        "newly_revealed_points": newly_revealed_points,
    }


def convert_excess_to_dolloss(
    session: Session, account_uid: int, media_id: str, excess: int, source: str = "tier_shift_excess"
) -> None:
    """
    Utilisé par le recalcul quotidien quand une descente de tier laisse un
    joueur avec plus de shards que le nouveau seuil requis. `excess` est
    positif (nombre de shards convertis) ; loggué en ShardLog avec un amount
    négatif (des shards sont retirés, pas accordés — distinct de
    apply_shard_grant qui logge un entitlement positif).
    """
    now = datetime.datetime.utcnow()
    settle_accrual(session, account_uid, now)  # le unlock qui accompagne la conversion change Σpps

    currency = get_or_create_currency(session, account_uid)
    currency.dolloss += excess
    session.add(currency)

    session.add(
        ShardLog(
            account_uid=account_uid,
            media_id=media_id,
            amount=-excess,
            source=source,
            game_room_id=None,
            created_at=now,
        )
    )


def get_loot_settings(session: Session) -> LootSettings:
    settings = session.get(LootSettings, 1)
    if settings is None:
        # Ne devrait arriver qu'en dev sans avoir jamais lancé init_db —
        # filet de repli plutôt qu'un crash, avec les mêmes valeurs de seed.
        settings = LootSettings(id=1)
        session.add(settings)
        session.flush()
    return settings


def get_booster_config(session: Session, booster_type: str) -> Optional[BoosterConfig]:
    return session.get(BoosterConfig, booster_type)


def get_all_booster_configs(session: Session) -> list[BoosterConfig]:
    # Ordre stable et prévisible pour l'affichage (boutique + admin) —
    # BOOSTER_TYPES ne sert plus que de seed mais garde l'ordre voulu.
    order = list(BOOSTER_TYPES.keys())
    rows = {c.booster_type: c for c in session.exec(select(BoosterConfig)).all()}
    return [rows[t] for t in order if t in rows]


def booster_price(session: Session, booster_type: str, boosters_purchased_count: int) -> float:
    config = get_booster_config(session, booster_type)
    growth = get_loot_settings(session).booster_price_growth
    return config.price_base * (growth ** boosters_purchased_count)


# Shard "cooloss" : un joker, pas liée à un media_id — appliquable sur
# n'importe quelle carte verrouillée au choix du joueur. Prix premium (une
# shard cooloss garantit exactement la carte qu'on veut, contrairement à un
# tirage de booster) ; même courbe de croissance que les boosters, sur son
# propre compteur. Valeurs par défaut/seed uniquement — voir LootSettings.
COOLOSS_SHARD_PRICE_BASE = 400.0
COOLOSS_SHARD_PRICE_GROWTH = 1.15

# Probabilité, par tirage individuel dans N'IMPORTE QUEL booster (indépendant
# du type acheté), qu'il se transforme en shard cooloss au lieu du tirage
# pondéré par tier habituel — le "loot" évoqué à côté de l'achat direct.
# Valeur par défaut/seed uniquement — voir LootSettings.
COOLOSS_SHARD_LOOT_CHANCE = 0.04


def cooloss_shard_price(session: Session, purchased_count: int) -> float:
    settings = get_loot_settings(session)
    return settings.cooloss_shard_price_base * (settings.cooloss_shard_price_growth ** purchased_count)


def apply_cooloss_shard(session: Session, account_uid: int, media_id: str) -> dict:
    """
    Dépense 1 shard cooloss du stock du joueur (lève ValueError si le stock
    est vide) et l'applique sur `media_id` via apply_shard_grant — même
    logique de cap/overflow/déblocage que n'importe quel autre grant. Ne
    commit pas — au caller de gérer la transaction (même contrat que
    apply_shard_grant).
    """
    currency = get_or_create_currency(session, account_uid)
    if currency.cooloss_shards < 1:
        raise ValueError("aucune shard cooloss en stock")
    currency.cooloss_shards -= 1
    session.add(currency)
    return apply_shard_grant(session, account_uid, media_id, amount=1, source="cooloss_shard")
