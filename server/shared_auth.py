"""
Vérification du cookie de session partagé émis par cooloss
(https://cooloss.nathangracia.com), utilisé pour reconnaître un compte déjà
connecté sur les autres apps "-oss" sans repasser par un login local.

Copie verbatim du vérificateur de Memoss (server/shared_auth.py dans
media-gallery) — port Python du schéma défini dans cooloss/lib/sharedToken.ts.
Si le format change là-bas, réplique le changement ici ET dans les autres
implémentations listées dans ~/docs/compte-unifie-cooloss.md. Vérification
stateless (HMAC local, pas d'appel réseau à cooloss) : si cooloss tombe, les
sessions déjà ouvertes continuent de fonctionner.

Format du token : "<payload base64url>.<hmac hex>"
payload (JSON) : { uid, username, displayName, isAdmin, isHabitue, avatarFile, volume, exp }
"""
import base64
import hashlib
import hmac
import json
import time
from typing import Optional, TypedDict

SHARED_SESSION_COOKIE = "nathangracia_session"


class SharedClaims(TypedDict):
    uid: int
    username: str
    isAdmin: bool
    avatarFile: Optional[str]
    # Volume général (0..1), partagé avec Memoss/Blindtoss/cooloss — voir
    # User.volume dans cooloss/prisma/schema.prisma.
    volume: float
    exp: int


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded)


def verify_shared_token(token: Optional[str], secret: str) -> Optional[SharedClaims]:
    if not token or not secret:
        return None
    parts = token.split(".")
    if len(parts) != 2:
        return None
    payload_b64, signature = parts

    expected = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None

    try:
        claims: SharedClaims = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None

    if not isinstance(claims.get("uid"), int) or not isinstance(claims.get("exp"), int):
        return None
    if time.time() * 1000 > claims["exp"]:
        return None

    return claims
