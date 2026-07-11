"""
Panneau admin — gestion en live des loot tables (boosters + shard cooloss),
sans redéploiement. Gated isAdmin (claims cooloss, voir auth.require_admin).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from auth import require_admin
from db import get_session
from economy import get_toast_color_settings
from models import BoosterConfig, LootSettings, ToastColorSettings

router = APIRouter(prefix="/api/admin", tags=["admin"])

HEX_COLOR = r"^#[0-9a-fA-F]{6}$"


class BoosterConfigPayload(BaseModel):
    label: str
    shards: int = Field(gt=0, le=20)
    price_base: float = Field(gt=0)
    weight_common: int = Field(ge=0)
    weight_rare: int = Field(ge=0)
    weight_epic: int = Field(ge=0)
    weight_legendary: int = Field(ge=0)


class ToastColorStopPayload(BaseModel):
    threshold: float = Field(ge=0)
    color: str = Field(pattern=HEX_COLOR)


class LootConfigPayload(BaseModel):
    booster_price_growth: float = Field(gt=1)
    cooloss_shard_price_base: float = Field(gt=0)
    cooloss_shard_price_growth: float = Field(gt=1)
    cooloss_shard_loot_chance: float = Field(ge=0, le=1)
    boosters: dict[str, BoosterConfigPayload]
    toast_color_stops: list[ToastColorStopPayload]


def _serialize(session: Session) -> dict:
    settings = session.get(LootSettings, 1)
    boosters = {
        c.booster_type: {
            "label": c.label,
            "shards": c.shards,
            "price_base": c.price_base,
            "weight_common": c.weight_common,
            "weight_rare": c.weight_rare,
            "weight_epic": c.weight_epic,
            "weight_legendary": c.weight_legendary,
        }
        for c in session.exec(select(BoosterConfig)).all()
    }
    toast = get_toast_color_settings(session)
    return {
        "booster_price_growth": settings.booster_price_growth,
        "cooloss_shard_price_base": settings.cooloss_shard_price_base,
        "cooloss_shard_price_growth": settings.cooloss_shard_price_growth,
        "cooloss_shard_loot_chance": settings.cooloss_shard_loot_chance,
        "boosters": boosters,
        "toast_color_stops": [
            {"threshold": toast.stop1_threshold, "color": toast.stop1_color},
            {"threshold": toast.stop2_threshold, "color": toast.stop2_color},
            {"threshold": toast.stop3_threshold, "color": toast.stop3_color},
            {"threshold": toast.stop4_threshold, "color": toast.stop4_color},
        ],
    }


@router.get("/loot-config", dependencies=[Depends(require_admin)])
def get_loot_config(session: Session = Depends(get_session)):
    return _serialize(session)


@router.put("/loot-config", dependencies=[Depends(require_admin)])
def update_loot_config(payload: LootConfigPayload, session: Session = Depends(get_session)):
    for booster_type, booster_payload in payload.boosters.items():
        config = session.get(BoosterConfig, booster_type)
        if config is None:
            raise HTTPException(status_code=400, detail=f"type de booster inconnu: {booster_type}")
        config.label = booster_payload.label
        config.shards = booster_payload.shards
        config.price_base = booster_payload.price_base
        config.weight_common = booster_payload.weight_common
        config.weight_rare = booster_payload.weight_rare
        config.weight_epic = booster_payload.weight_epic
        config.weight_legendary = booster_payload.weight_legendary
        session.add(config)

    settings = session.get(LootSettings, 1)
    settings.booster_price_growth = payload.booster_price_growth
    settings.cooloss_shard_price_base = payload.cooloss_shard_price_base
    settings.cooloss_shard_price_growth = payload.cooloss_shard_price_growth
    settings.cooloss_shard_loot_chance = payload.cooloss_shard_loot_chance
    session.add(settings)

    stops = sorted(payload.toast_color_stops, key=lambda s: s.threshold)
    if len(stops) != 4:
        raise HTTPException(status_code=400, detail="il faut exactement 4 paliers de couleur")
    toast = session.get(ToastColorSettings, 1)
    toast.stop1_threshold, toast.stop1_color = stops[0].threshold, stops[0].color
    toast.stop2_threshold, toast.stop2_color = stops[1].threshold, stops[1].color
    toast.stop3_threshold, toast.stop3_color = stops[2].threshold, stops[2].color
    toast.stop4_threshold, toast.stop4_color = stops[3].threshold, stops[3].color
    session.add(toast)

    session.commit()
    return _serialize(session)
