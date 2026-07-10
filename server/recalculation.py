"""
Recalcul quotidien : popularité/qualité de chaque média → tier → multiplicateur
→ points_per_sec, avec préservation des déblocages acquis (montée de tier) et
conversion de l'excédent en Dolloss (descente de tier). Voir le plan §5 pour
le détail des règles.

Tri déterministe obligatoire : avec ~200 médias dont beaucoup à égalité
(notamment les 0 vue), un tri instable réordonnerait les ex æquo d'un jour à
l'autre → changements de tier fantômes aux frontières de percentile. D'où le
tiebreak explicite sur media_id partout.
"""
import datetime
import logging
from collections import defaultdict

from sqlmodel import Session, select

from economy import (
    BASE_POINTS_PER_SEC,
    QUALITY_MULTIPLIER_MAX,
    QUALITY_MULTIPLIER_MIN,
    SHARDS_REQUIRED,
    convert_excess_to_dolloss,
    settle_accrual,
    tier_for_percentile,
)
from memoss_client import MediaStat, fetch_media_stats
from models import MemeCard, PlayerCollection, TierChangeLog

log = logging.getLogger("shardoss")

TIER_ORDER = {"common": 0, "rare": 1, "epic": 2, "legendary": 3}


def _quality_score(stat: MediaStat) -> float:
    return (stat.total_stars_sum / stat.vote_count_sum) if stat.vote_count_sum else 0.0


def _compute_tiers(stats: list[MediaStat]) -> dict[str, str]:
    ordered = sorted(stats, key=lambda s: (-s.play_count, s.media_id))
    total = len(ordered)
    return {s.media_id: tier_for_percentile(i / total) for i, s in enumerate(ordered)}


def _compute_quality_multipliers(stats: list[MediaStat], tier_by_media: dict[str, str]) -> dict[str, float]:
    by_tier: dict[str, list[MediaStat]] = defaultdict(list)
    for s in stats:
        by_tier[tier_by_media[s.media_id]].append(s)

    result: dict[str, float] = {}
    for items in by_tier.values():
        ordered = sorted(items, key=lambda s: (-_quality_score(s), s.media_id))
        n = len(ordered)
        for i, s in enumerate(ordered):
            # i=0 est le meilleur du tier (tri décroissant) -> inv_pct proche de 1
            inv_pct = (1 - i / (n - 1)) if n > 1 else 0.5
            result[s.media_id] = QUALITY_MULTIPLIER_MIN + inv_pct * (
                QUALITY_MULTIPLIER_MAX - QUALITY_MULTIPLIER_MIN
            )
    return result


def _handle_tier_transition(
    session: Session,
    media_id: str,
    new_required: int,
    direction: str,
    now: datetime.datetime,
) -> None:
    collections = session.exec(
        select(PlayerCollection).where(PlayerCollection.media_id == media_id)
    ).all()
    for coll in collections:
        if direction == "up":
            if coll.unlocked:
                continue  # déblocage déjà acquis, préservé tel quel
            coll.shards_required = new_required
            session.add(coll)
            continue

        # direction == "down"
        if coll.shards_owned > new_required:
            excess = coll.shards_owned - new_required
            coll.shards_owned = new_required
            coll.shards_required = new_required
            if not coll.unlocked:
                coll.unlocked_at = now
            coll.unlocked = True
            session.add(coll)
            convert_excess_to_dolloss(session, coll.account_uid, media_id, excess)
        else:
            coll.shards_required = new_required
            session.add(coll)


def _upsert_card(session: Session, stat: MediaStat, tier: str, quality_mult: float, now: datetime.datetime) -> bool:
    """Retourne True si le tier a changé."""
    card = session.exec(select(MemeCard).where(MemeCard.media_id == stat.media_id)).first()
    old_tier = card.tier if card else None
    new_pps = BASE_POINTS_PER_SEC[tier] * quality_mult
    new_required = SHARDS_REQUIRED[tier]

    pps_changed = card is not None and card.points_per_sec != new_pps
    if pps_changed:
        # Régler l'accrual de chaque joueur ayant cette carte débloquée AVANT
        # d'écrire le nouveau taux — sinon il s'appliquerait rétroactivement.
        affected_uids = session.exec(
            select(PlayerCollection.account_uid).where(
                PlayerCollection.media_id == stat.media_id, PlayerCollection.unlocked == True  # noqa: E712
            )
        ).all()
        for uid in affected_uids:
            settle_accrual(session, uid, now)

    if card is None:
        card = MemeCard(media_id=stat.media_id)

    card.tier = tier
    card.popularity_score = stat.play_count
    card.quality_score = _quality_score(stat)
    card.quality_multiplier = quality_mult
    card.points_per_sec = new_pps
    card.duration_seconds = stat.duration_seconds
    card.shards_required = new_required
    card.updated_at = now
    session.add(card)
    session.flush()

    tier_changed = old_tier is not None and old_tier != tier
    if tier_changed:
        direction = "up" if TIER_ORDER[tier] > TIER_ORDER[old_tier] else "down"
        session.add(
            TierChangeLog(media_id=stat.media_id, old_tier=old_tier, new_tier=tier, direction=direction, occurred_at=now)
        )
        _handle_tier_transition(session, stat.media_id, new_required, direction, now)

    return tier_changed


def run_daily_recalculation(session: Session) -> dict:
    stats = fetch_media_stats()
    if not stats:
        log.warning("Recalcul quotidien: stats Memoss vides, run abandonné.")
        return {"ok": False, "reason": "empty_stats"}

    now = datetime.datetime.utcnow()
    tier_by_media = _compute_tiers(stats)
    quality_mult_by_media = _compute_quality_multipliers(stats, tier_by_media)

    tier_changes = 0
    for stat in stats:
        changed = _upsert_card(
            session, stat, tier_by_media[stat.media_id], quality_mult_by_media[stat.media_id], now
        )
        tier_changes += int(changed)

    session.commit()
    log.info("Recalcul quotidien terminé: %d médias, %d changements de tier.", len(stats), tier_changes)
    return {"ok": True, "media_count": len(stats), "tier_changes": tier_changes}
