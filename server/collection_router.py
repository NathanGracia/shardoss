"""
Lecture de la collection d'un joueur — n'écrit jamais rien (voir plan §7 :
le solde de Dolloss affiché est calculé à la volée sans persister l'accrual).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from auth import get_account_claims, require_account
from db import get_session
from economy import live_dolloss_balance, sum_points_per_sec
from models import MemeCard, PlayerCollection
from shatter import fragments_for_player, get_or_generate_fragments

router = APIRouter(prefix="/api", tags=["collection"])


@router.get("/collection")
def get_collection(claims: dict = Depends(require_account), session: Session = Depends(get_session)):
    account_uid = claims["uid"]

    rows = session.exec(
        select(PlayerCollection, MemeCard)
        .join(MemeCard, MemeCard.media_id == PlayerCollection.media_id)
        .where(PlayerCollection.account_uid == account_uid)
    ).all()

    cards = [
        {
            "media_id": coll.media_id,
            "tier": card.tier,
            "points_per_sec": card.points_per_sec,
            "quality_multiplier": card.quality_multiplier,
            "duration_seconds": card.duration_seconds,
            "shards_owned": coll.shards_owned,
            "shards_required": coll.shards_required,
            "unlocked": coll.unlocked,
        }
        for coll, card in rows
    ]

    return {
        "dolloss": live_dolloss_balance(session, account_uid),
        "points_per_sec_total": sum_points_per_sec(session, account_uid),
        "cards": cards,
    }


@router.get("/collection/{media_id}/fragments")
def get_fragments(
    media_id: str, claims: dict = Depends(require_account), session: Session = Depends(get_session)
):
    account_uid = claims["uid"]
    coll = session.exec(
        select(PlayerCollection).where(
            PlayerCollection.account_uid == account_uid, PlayerCollection.media_id == media_id
        )
    ).first()
    if coll is None:
        raise HTTPException(status_code=404, detail="carte jamais touchée")

    card = session.exec(select(MemeCard).where(MemeCard.media_id == media_id)).first()
    if card is None:
        raise HTTPException(status_code=404, detail="média inconnu")

    fragments = get_or_generate_fragments(session, media_id, card.tier, card.shards_required)
    return fragments_for_player(fragments, coll.shards_owned)


@router.get("/summary")
def get_summary(claims: dict | None = Depends(get_account_claims), session: Session = Depends(get_session)):
    """
    Utilisé par le widget opt-in intégré dans l'UI Memoss (cross-origin,
    cookie cooloss déjà partagé). Ne lève jamais 401 — retourne loggedIn:false
    pour que le widget puisse afficher un état "non connecté" au lieu de
    planter le fetch.
    """
    if claims is None:
        return {"loggedIn": False}

    account_uid = claims["uid"]
    unlocked_count = session.exec(
        select(PlayerCollection).where(
            PlayerCollection.account_uid == account_uid, PlayerCollection.unlocked == True  # noqa: E712
        )
    ).all()

    return {
        "loggedIn": True,
        "dolloss": live_dolloss_balance(session, account_uid),
        "points_per_sec_total": sum_points_per_sec(session, account_uid),
        "cards_unlocked": len(unlocked_count),
    }
