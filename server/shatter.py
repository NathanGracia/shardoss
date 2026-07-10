"""
Génération et cache des fragments "verre brisé" (Voronoi) par média — voir
plan §6. Le serveur est la seule source de vérité géométrique ; le client se
contente de peindre les polygones fournis.

Déterminisme : les points de seed sont générés par un PRNG seedé sur
media_id, donc reproductibles même sans cache — mais le whitepaper (§5.2)
exige explicitement un cache par media_id (éviter de recalculer Voronoi+
clipping à chaque chargement), d'où la persistance dans CardFragments.
"""
import json
import random

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, box
from sqlmodel import Session, select

from models import CardFragments, MemeCard

UNIT_SQUARE = box(0.0, 0.0, 1.0, 1.0)


def _seed_points(media_id: str, piece_count: int) -> np.ndarray:
    rng = random.Random(media_id)
    pts = [(rng.uniform(0, 1), rng.uniform(0, 1)) for _ in range(piece_count)]
    # Points de padding hors-cadre pour que les cellules Voronoi des points
    # intérieurs soient bornées naturellement par le clipping.
    pts += [(rng.uniform(-0.5, 1.5), rng.uniform(-0.5, 1.5)) for _ in range(piece_count * 3)]
    # Ancres fixes très loin dans les 4 coins : un point intérieur proche
    # d'un bord/coin du carré unité peut quand même avoir une cellule non
    # bornée avec juste le padding aléatoire ci-dessus (surtout à faible
    # piece_count, ex. tier Common à 3 pièces) — ces ancres garantissent que
    # toute cellule intérieure est fermée par au moins un voisin dans chaque
    # direction, quel que soit le nombre de pièces.
    pts += [(-20, -20), (21, -20), (-20, 21), (21, 21)]
    return np.array(pts)


def _voronoi_polygons(media_id: str, piece_count: int) -> list[list[list[float]]]:
    points = _seed_points(media_id, piece_count)
    vor = Voronoi(points)

    polygons: list[list[list[float]]] = []
    for point_idx in range(piece_count):  # seuls les `piece_count` premiers points nous intéressent
        region_idx = vor.point_region[point_idx]
        region = vor.regions[region_idx]
        if not region or -1 in region:
            # Cellule non bornée (rare avec le sur-échantillonnage ci-dessus) —
            # on retombe sur un petit carré autour du point plutôt que de
            # planter tout le calcul pour un seul média.
            x, y = points[point_idx]
            cell = box(x - 0.05, y - 0.05, x + 0.05, y + 0.05)
        else:
            verts = [vor.vertices[i] for i in region]
            cell = Polygon(verts)

        clipped = cell.intersection(UNIT_SQUARE)
        if clipped.is_empty:
            continue
        if clipped.geom_type == "Polygon":
            coords = list(clipped.exterior.coords)
        else:  # MultiPolygon improbable ici (cellule Voronoi convexe ∩ carré convexe = convexe) mais on ne prend pas de risque
            largest = max(clipped.geoms, key=lambda g: g.area)
            coords = list(largest.exterior.coords)
        polygons.append([[round(x, 5), round(y, 5)] for x, y in coords])

    return polygons


def get_or_generate_fragments(session: Session, media_id: str, tier: str, piece_count: int) -> CardFragments:
    existing = session.get(CardFragments, media_id)
    if existing is not None and existing.piece_count == piece_count:
        return existing

    polygons = _voronoi_polygons(media_id, piece_count)
    rng = random.Random(f"{media_id}:reveal")
    reveal_order = list(range(len(polygons)))
    rng.shuffle(reveal_order)

    fragments = CardFragments(
        media_id=media_id,
        tier=tier,
        piece_count=len(polygons),
        polygons_json=json.dumps(polygons),
        reveal_order_json=json.dumps(reveal_order),
    )
    session.merge(fragments)
    session.commit()
    return session.get(CardFragments, media_id)


def fragments_for_player(fragments: CardFragments, shards_owned: int) -> dict:
    polygons = json.loads(fragments.polygons_json)
    reveal_order = json.loads(fragments.reveal_order_json)
    # reveal_position[piece_index] = k tel que reveal_order[k] == piece_index
    reveal_position = {piece_index: k for k, piece_index in enumerate(reveal_order)}

    pieces = [
        {"points": polygons[i], "revealed": shards_owned > reveal_position.get(i, i)}
        for i in range(len(polygons))
    ]
    return {"piece_count": fragments.piece_count, "pieces": pieces}
