"""
Boosters : prix scalant + achat (5 tirages indépendants pondérés par tier,
chacun peut tomber sur un média et une rareté différents — confirmé avec
l'utilisateur, voir plan §7).
"""
import random

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, func, select

from auth import require_account
from db import get_session
from economy import (
    BOOSTER_SHARDS_PER_PURCHASE,
    BOOSTER_TIER_WEIGHTS,
    apply_shard_grant,
    booster_price,
    get_or_create_currency,
    settle_accrual,
)
from models import MemeCard, PlayerCurrency

router = APIRouter(prefix="/api/boosters", tags=["economy"])

# Ordre de repli si le tier tiré n'a (momentanément) aucune carte en base.
_TIER_FALLBACK_ORDER = ["common", "rare", "epic", "legendary"]


def _random_media_in_tier(session: Session, tier: str) -> str | None:
    return session.exec(
        select(MemeCard.media_id).where(MemeCard.tier == tier).order_by(func.random()).limit(1)
    ).first()


def _pick_media_for_tier(session: Session, tier: str) -> tuple[str | None, str | None]:
    media_id = _random_media_in_tier(session, tier)
    if media_id:
        return media_id, tier
    for fallback_tier in _TIER_FALLBACK_ORDER:
        media_id = _random_media_in_tier(session, fallback_tier)
        if media_id:
            return media_id, fallback_tier
    return None, None


@router.get("/price")
def get_price(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    row = session.get(PlayerCurrency, claims["uid"])
    count = row.boosters_purchased_count if row else 0
    return {"price": booster_price(count)}


@router.post("/buy")
def buy_booster(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    account_uid = claims["uid"]

    settle_accrual(session, account_uid)
    currency = get_or_create_currency(session, account_uid)
    price = booster_price(currency.boosters_purchased_count)
    if currency.dolloss < price:
        raise HTTPException(status_code=402, detail="solde de Dolloss insuffisant")

    currency.dolloss -= price
    currency.boosters_purchased_count += 1
    session.add(currency)

    tiers_drawn = random.choices(
        list(BOOSTER_TIER_WEIGHTS.keys()),
        weights=list(BOOSTER_TIER_WEIGHTS.values()),
        k=BOOSTER_SHARDS_PER_PURCHASE,
    )

    results = []
    for tier in tiers_drawn:
        media_id, actual_tier = _pick_media_for_tier(session, tier)
        if media_id is None:
            # Aucune carte du tout en base — ne devrait arriver qu'avant le
            # tout premier recalcul quotidien.
            continue
        results.append(apply_shard_grant(session, account_uid, media_id, amount=1, source="booster"))

    session.commit()
    return {"ok": True, "dolloss": currency.dolloss, "results": results}
