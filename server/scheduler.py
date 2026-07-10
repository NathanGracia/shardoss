"""
Ordonnancement du recalcul quotidien (APScheduler in-process — voir plan §5
pour la justification) + endpoint admin pour déclencher un run manuel
(indispensable pour tester sans attendre 24h).

Nécessite `uvicorn --workers 1` (voir Dockerfile) : plusieurs workers
feraient tourner le job en double.
"""
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import APIRouter, Depends
from sqlmodel import Session

from auth import require_admin
from db import engine
from recalculation import run_daily_recalculation

log = logging.getLogger("shardoss")

router = APIRouter(prefix="/api/admin", tags=["admin"])

scheduler = AsyncIOScheduler(timezone="Europe/Paris")


def _run_job() -> None:
    with Session(engine) as session:
        try:
            run_daily_recalculation(session)
        except Exception:
            log.exception("Recalcul quotidien planifié: échec.")


def start_scheduler() -> None:
    scheduler.add_job(
        _run_job, "cron", hour=3, minute=0, id="daily_recalc", misfire_grace_time=3600, replace_existing=True
    )
    scheduler.start()


@router.post("/recalculate", dependencies=[Depends(require_admin)])
def recalculate_now():
    with Session(engine) as session:
        return run_daily_recalculation(session)
