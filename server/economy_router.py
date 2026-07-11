"""
Boosters : 3 produits au choix (Common/Rare/Epic — voir BOOSTER_TYPES dans
economy.py), moins de shards mais de meilleures cotes en montant en gamme.
Chaque tirage de tier est indépendant, peut tomber sur un média et une
rareté différents — y compris un legendary depuis un booster common (rare,
mais jamais exclu).
"""
import random

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, func, select

from auth import require_account
from db import get_session
from economy import (
    BOOSTER_TYPES,
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


class BuyBoosterPayload(BaseModel):
    booster_type: str = "common"


@router.get("/prices")
def get_prices(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    row = session.get(PlayerCurrency, claims["uid"])
    return {
        booster_type: {
            "label": meta["label"],
            "shards": meta["shards"],
            # Compteur propre à CE type de booster — acheter un common ne
            # fait pas monter le prix du rare ou de l'epic.
            "price": booster_price(booster_type, getattr(row, f"boosters_purchased_{booster_type}", 0) if row else 0),
            # Vignette du pack : un meme au hasard parmi ceux déjà classés
            # dans la rareté correspondante (peut être null avant le tout
            # premier recalcul quotidien — le front retombe alors sur l'icône
            # texte "PACK").
            "thumbnail_media_id": _random_media_in_tier(session, booster_type),
        }
        for booster_type, meta in BOOSTER_TYPES.items()
    }


@router.post("/buy")
def buy_booster(
    payload: BuyBoosterPayload,
    claims: dict = Depends(require_account),
    session: Session = Depends(get_session),
):
    account_uid = claims["uid"]
    booster_type = payload.booster_type
    if booster_type not in BOOSTER_TYPES:
        raise HTTPException(status_code=400, detail=f"type de booster inconnu: {booster_type}")
    meta = BOOSTER_TYPES[booster_type]

    settle_accrual(session, account_uid)
    currency = get_or_create_currency(session, account_uid)
    count_field = f"boosters_purchased_{booster_type}"
    price = booster_price(booster_type, getattr(currency, count_field))
    if currency.dolloss < price:
        raise HTTPException(status_code=402, detail="solde de Dolloss insuffisant")

    currency.dolloss -= price
    setattr(currency, count_field, getattr(currency, count_field) + 1)
    session.add(currency)

    tiers_drawn = random.choices(
        list(meta["weights"].keys()),
        weights=list(meta["weights"].values()),
        k=meta["shards"],
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
    return {"ok": True, "dolloss": currency.dolloss, "booster_type": booster_type, "results": results}
