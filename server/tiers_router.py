"""
Notifications de mouvement de tier — polling pur (temps réel hors scope MVP,
voir whitepaper §8). Curseur suivi côté client (localStorage), pas d'état de
lecture par joueur côté serveur.
"""
from fastapi import APIRouter, Depends
from sqlmodel import Session, func, select

from auth import require_account
from db import get_session
from models import PlayerCollection, TierChangeLog

router = APIRouter(prefix="/api/tiers", tags=["tiers"])


@router.get("/notifications")
def get_notifications(
    since_id: int | None = None,
    claims: dict = Depends(require_account),
    session: Session = Depends(get_session),
):
    latest = session.exec(select(func.max(TierChangeLog.id))).one() or 0

    if since_id is None:
        # Première visite (pas de curseur en localStorage) : on initialise le
        # curseur silencieusement plutôt que de renvoyer tout l'historique.
        return {"latest_id": latest, "changes": []}

    touched_media_ids = session.exec(
        select(PlayerCollection.media_id).where(PlayerCollection.account_uid == claims["uid"])
    ).all()
    touched = set(touched_media_ids)
    if not touched:
        return {"latest_id": latest, "changes": []}

    rows = session.exec(
        select(TierChangeLog)
        .where(TierChangeLog.id > since_id, TierChangeLog.media_id.in_(touched))
        .order_by(TierChangeLog.id)
    ).all()

    return {
        "latest_id": latest,
        "changes": [
            {
                "media_id": r.media_id,
                "old_tier": r.old_tier,
                "new_tier": r.new_tier,
                "direction": r.direction,
                "occurred_at": r.occurred_at.isoformat(),
            }
            for r in rows
        ],
    }
