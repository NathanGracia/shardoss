"""
Dépendances FastAPI pour l'auth cooloss — même contrat que Memoss
(GET /api/whoami, claims stockés dans request.state).
"""
from fastapi import HTTPException, Request

from db import get_config
from shared_auth import SHARED_SESSION_COOKIE, verify_shared_token


def get_account_claims(request: Request) -> dict | None:
    token = request.cookies.get(SHARED_SESSION_COOKIE)
    secret = get_config().get("shared_session_secret", "")
    return verify_shared_token(token, secret)


def require_account(request: Request) -> dict:
    claims = get_account_claims(request)
    if claims is None:
        raise HTTPException(status_code=401, detail="cooloss session required")
    return claims


def require_admin(request: Request) -> dict:
    claims = require_account(request)
    if not claims.get("isAdmin"):
        raise HTTPException(status_code=403, detail="admin only")
    return claims
