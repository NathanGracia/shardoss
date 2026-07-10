"""
Logique économique partagée : constantes de balance, accrual paresseux de
Dolloss, et l'unique point d'entrée pour créditer des shards (garantit que
"que se passe-t-il quand un grant dépasse la marge restante" n'est écrit
qu'une fois — réutilisé par webhook_router, economy_router (boosters) et
recalculation (descente de tier)).
"""
import datetime
from typing import Optional

from sqlmodel import Session, func, select

from models import MemeCard, PlayerCollection, PlayerCurrency, ShardLog

BASE_POINTS_PER_SEC = {"common": 1.0, "rare": 3.0, "epic": 6.0, "legendary": 10.0}
SHARDS_REQUIRED = {"common": 3, "rare": 6, "epic": 12, "legendary": 24}
QUALITY_MULTIPLIER_MIN = 0.8
QUALITY_MULTIPLIER_MAX = 1.5

BOOSTER_PRICE_BASE = 50.0
BOOSTER_PRICE_GROWTH = 1.15
BOOSTER_SHARDS_PER_PURCHASE = 5
BOOSTER_TIER_WEIGHTS = {"common": 45, "rare": 30, "epic": 18, "legendary": 7}

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

    remaining = max(coll.shards_required - coll.shards_owned, 0)
    applied = min(amount, remaining)
    overflow = amount - applied

    coll.shards_owned += applied
    newly_unlocked = False
    if coll.shards_owned >= coll.shards_required and not coll.unlocked:
        coll.unlocked = True
        coll.unlocked_at = now
        newly_unlocked = True
    session.add(coll)

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
        "shard_applied": applied,
        "overflow_to_dolloss": overflow,
        "unlocked": coll.unlocked,
        "newly_unlocked": newly_unlocked,
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


def booster_price(boosters_purchased_count: int) -> float:
    return BOOSTER_PRICE_BASE * (BOOSTER_PRICE_GROWTH ** boosters_purchased_count)
