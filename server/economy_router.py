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
    apply_cooloss_shard,
    apply_shard_grant,
    booster_price,
    cooloss_shard_price,
    get_all_booster_configs,
    get_booster_config,
    get_loot_settings,
    get_or_create_currency,
    settle_accrual,
)
from models import MemeCard, PlayerCurrency

router = APIRouter(prefix="/api/boosters", tags=["economy"])
cooloss_shard_router = APIRouter(prefix="/api/cooloss-shard", tags=["economy"])

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
        config.booster_type: {
            "label": config.label,
            "shards": config.shards,
            # Compteur propre à CE type de booster — acheter un common ne
            # fait pas monter le prix du rare ou de l'epic.
            "price": booster_price(session, config.booster_type, getattr(row, f"boosters_purchased_{config.booster_type}", 0) if row else 0),
            # Vignette du pack : un meme au hasard parmi ceux déjà classés
            # dans la rareté correspondante (peut être null avant le tout
            # premier recalcul quotidien — le front retombe alors sur l'icône
            # texte "PACK").
            "thumbnail_media_id": _random_media_in_tier(session, config.booster_type),
        }
        for config in get_all_booster_configs(session)
    }


@router.post("/buy")
def buy_booster(
    payload: BuyBoosterPayload,
    claims: dict = Depends(require_account),
    session: Session = Depends(get_session),
):
    account_uid = claims["uid"]
    booster_type = payload.booster_type
    config = get_booster_config(session, booster_type)
    if config is None:
        raise HTTPException(status_code=400, detail=f"type de booster inconnu: {booster_type}")

    settle_accrual(session, account_uid)
    currency = get_or_create_currency(session, account_uid)
    count_field = f"boosters_purchased_{booster_type}"
    price = booster_price(session, booster_type, getattr(currency, count_field))
    if currency.dolloss < price:
        raise HTTPException(status_code=402, detail="solde de Dolloss insuffisant")

    currency.dolloss -= price
    setattr(currency, count_field, getattr(currency, count_field) + 1)
    session.add(currency)

    loot_chance = get_loot_settings(session).cooloss_shard_loot_chance
    weights = {
        "common": config.weight_common,
        "rare": config.weight_rare,
        "epic": config.weight_epic,
        "legendary": config.weight_legendary,
    }
    results = []
    for _ in range(config.shards):
        # Chaque tirage individuel a une petite chance de devenir une shard
        # cooloss (joker) au lieu du tirage pondéré par tier habituel — le
        # "loot" du joker, indépendant du type de booster acheté.
        if random.random() < loot_chance:
            currency.cooloss_shards += 1
            session.add(currency)
            results.append({"tier": "cooloss", "media_id": None, "cooloss_shards": currency.cooloss_shards})
            continue

        tier = random.choices(list(weights.keys()), weights=list(weights.values()), k=1)[0]
        media_id, actual_tier = _pick_media_for_tier(session, tier)
        if media_id is None:
            # Aucune carte du tout en base — ne devrait arriver qu'avant le
            # tout premier recalcul quotidien.
            continue
        results.append(apply_shard_grant(session, account_uid, media_id, amount=1, source="booster"))

    session.commit()
    return {"ok": True, "dolloss": currency.dolloss, "booster_type": booster_type, "results": results}


class ApplyCoolossShardPayload(BaseModel):
    media_id: str


@cooloss_shard_router.get("")
def get_cooloss_shard_status(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    currency = session.get(PlayerCurrency, claims["uid"])
    count = currency.cooloss_shards if currency else 0
    purchased = currency.cooloss_shards_purchased_count if currency else 0
    return {"count": count, "price": cooloss_shard_price(session, purchased)}


@cooloss_shard_router.post("/buy")
def buy_cooloss_shard(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    account_uid = claims["uid"]
    settle_accrual(session, account_uid)
    currency = get_or_create_currency(session, account_uid)
    price = cooloss_shard_price(session, currency.cooloss_shards_purchased_count)
    if currency.dolloss < price:
        raise HTTPException(status_code=402, detail="solde de Dolloss insuffisant")

    currency.dolloss -= price
    currency.cooloss_shards_purchased_count += 1
    currency.cooloss_shards += 1
    session.add(currency)
    session.commit()
    return {
        "ok": True,
        "dolloss": currency.dolloss,
        "cooloss_shards": currency.cooloss_shards,
        "next_price": cooloss_shard_price(session, currency.cooloss_shards_purchased_count),
    }


@cooloss_shard_router.post("/apply")
def use_cooloss_shard(
    payload: ApplyCoolossShardPayload,
    claims: dict = Depends(require_account),
    session: Session = Depends(get_session),
):
    account_uid = claims["uid"]
    try:
        result = apply_cooloss_shard(session, account_uid, payload.media_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="aucune shard cooloss en stock")

    currency = get_or_create_currency(session, account_uid)
    session.commit()
    return {"ok": True, "cooloss_shards": currency.cooloss_shards, "result": result}
