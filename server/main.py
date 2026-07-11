"""
Shardoss — point d'entrée FastAPI.

Pipeline CI/CD (push main -> SSH -> docker compose up -d --build) vérifié
fonctionnel le 2026-07-10.
"""
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import collection_router
import economy_router
import scheduler
import tiers_router
import webhook_router
from auth import get_account_claims
from db import get_config, init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("shardoss")

app = FastAPI(title="Shardoss")

init_db()

_cfg = get_config()
_memoss_origin = _cfg.get("memoss_origin", "")
if _memoss_origin:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[_memoss_origin],
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

app.include_router(webhook_router.router)
app.include_router(collection_router.router)
app.include_router(economy_router.router)
app.include_router(economy_router.cooloss_shard_router)
app.include_router(tiers_router.router)
app.include_router(scheduler.router)


@app.on_event("startup")
def _on_startup():
    scheduler.start_scheduler()
    log.info("Shardoss démarré.")


@app.get("/api/whoami")
def whoami(request: Request):
    claims = get_account_claims(request)
    if not claims:
        return {"loggedIn": False}
    return {
        "loggedIn": True,
        "username": claims.get("username"),
        "displayName": claims.get("displayName"),
        "isAdmin": bool(claims.get("isAdmin")),
        "isHabitue": bool(claims.get("isHabitue")),
        "avatarFile": claims.get("avatarFile"),
        "volume": claims.get("volume", 0.15),
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")
