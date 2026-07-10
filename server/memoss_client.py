"""
Client HTTP vers Memoss — utilisé uniquement par le batch de recalcul
quotidien pour tirer les stats de popularité/qualité de la galerie.
"""
import logging

import httpx

from db import get_config

log = logging.getLogger("shardoss")


class MediaStat:
    __slots__ = ("media_id", "duration_seconds", "play_count", "total_stars_sum", "vote_count_sum")

    def __init__(self, media_id, duration_seconds, play_count, total_stars_sum, vote_count_sum):
        self.media_id = media_id
        self.duration_seconds = duration_seconds
        self.play_count = play_count
        self.total_stars_sum = total_stars_sum
        self.vote_count_sum = vote_count_sum


def fetch_media_stats() -> list[MediaStat]:
    """
    Tire GET /api/shardoss/stats sur Memoss — population complète des médias
    tag=cinema/video (y compris ceux à 0 vue), nécessaire pour des percentiles
    corrects sur toute la galerie. Lève une exception si Memoss est
    injoignable ou mal configuré — le caller (recalculation.py) décide s'il
    faut abandonner le run plutôt que de recalculer sur des données
    partielles/absentes.
    """
    cfg = get_config()
    base_url = cfg.get("memoss_base_url", "").rstrip("/")
    api_key = cfg.get("memoss_api_key", "")
    if not base_url or not api_key:
        raise RuntimeError("memoss_base_url / memoss_api_key non configurés")

    resp = httpx.get(
        f"{base_url}/api/shardoss/stats",
        headers={"x-api-key": api_key},
        timeout=30.0,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        MediaStat(
            media_id=item["uuid"],
            duration_seconds=item.get("duration_seconds"),
            play_count=item.get("play_count", 0),
            total_stars_sum=item.get("total_stars_sum", 0),
            vote_count_sum=item.get("vote_count_sum", 0),
        )
        for item in data
    ]
