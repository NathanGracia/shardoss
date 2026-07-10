"""
Réception du webhook de fin de partie envoyé par Memoss (best-effort,
fire-and-forget côté Memoss — voir server/shardoss_client.py dans
media-gallery). Toute la sûreté de ré-émission est gérée ici via ShardLog.

Mécanique de distribution (clarifiée avec l'utilisateur, voir le plan) :
le rang qui compte est celui des LÉGENDES (réponses), pas celui des joueurs.
Memoss envoie la liste complète des légendes de la partie (jusqu'à 3 par
joueur) ; on les trie par qualité, on prend les `player_count` meilleures, et
le rang i (1-indexé) dans ce top N reçoit N-i+1 shards sur SA propre carte
(pas sur les autres médias de la partie). Un joueur peut apparaître plusieurs
fois (plusieurs légendes dans le top N, sur des médias différents) ou pas du
tout. Les légendes d'invités (account_uid null) consomment normalement leur
rang mais ne génèrent aucune écriture.
"""
import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from db import get_session, get_config
from economy import apply_shard_grant
from models import ShardLog

log = logging.getLogger("shardoss")

router = APIRouter(prefix="/api/webhook", tags=["webhook"])


class LegendPayload(BaseModel):
    account_uid: int | None = None
    media_id: str
    total_stars: int = 0
    vote_count: int = 0


class GameEndPayload(BaseModel):
    game_room_id: int
    player_count: int
    legends: list[LegendPayload]


def require_memoss_key(x_shardoss_key: str = Header(default="")) -> None:
    expected = get_config().get("memoss_webhook_key", "")
    if not expected or x_shardoss_key != expected:
        raise HTTPException(status_code=401, detail="invalid or missing x-shardoss-key")


def _already_processed(session: Session, game_room_id: int) -> bool:
    existing = session.exec(
        select(ShardLog.id)
        .where(ShardLog.game_room_id == game_room_id, ShardLog.source == "game_global_rank")
        .limit(1)
    ).first()
    return existing is not None


@router.post("/game-end", dependencies=[Depends(require_memoss_key)])
def game_end(payload: GameEndPayload, session: Session = Depends(get_session)):
    if _already_processed(session, payload.game_room_id):
        return {"ok": True, "skipped": "already_processed"}

    if payload.player_count <= 0 or not payload.legends:
        return {"ok": True, "skipped": "no_legends"}

    ranked = sorted(
        payload.legends,
        key=lambda leg: (
            (leg.total_stars / leg.vote_count) if leg.vote_count else 0,
            leg.total_stars,
        ),
        reverse=True,
    )[: payload.player_count]

    processed = 0
    for i, legend in enumerate(ranked):
        shard_amount = payload.player_count - i
        if legend.account_uid is None:
            continue  # invité — le rang est consommé mais ne génère aucune écriture
        apply_shard_grant(
            session,
            account_uid=legend.account_uid,
            media_id=legend.media_id,
            amount=shard_amount,
            source="game_global_rank",
            game_room_id=payload.game_room_id,
        )
        processed += 1

    if processed == 0:
        # Que des invités dans le top N : rien n'a été appliqué, mais on log
        # quand même un marqueur pour que l'idempotence fonctionne au replay.
        session.add(
            ShardLog(
                account_uid=0,
                media_id="",
                amount=0,
                source="game_global_rank",
                game_room_id=payload.game_room_id,
            )
        )

    session.commit()
    log.info("game-end webhook traité: room=%s processed=%d", payload.game_room_id, processed)
    return {"ok": True, "processed": processed}
