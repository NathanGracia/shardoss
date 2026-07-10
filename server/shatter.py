"""
Génération et cache des fragments "verre brisé" par média — voir plan §6.
Le serveur est la seule source de vérité géométrique ; le client se
contente de peindre les polygones fournis.

Algorithme — maillage fin puis fusion, pas une Voronoi directe à
piece_count cellules :
  1. Un maillage Voronoi FIN à ~30-120 cellules (indépendant de piece_count,
     juste assez de granularité) est généré et clippé au carré unité.
  2. Ces cellules fines sont regroupées en exactement `piece_count` régions
     par croissance de région sur le graphe d'adjacence (chaque groupe
     absorbe une cellule voisine non prise, tour à tour), puis fusionnées
     en un polygone par groupe.

Ce détour donne des pièces bien plus organiques/texturées qu'une Voronoi
directe à piece_count=3 (qui produit des cellules biscornues et peu
lisibles à faible nombre de pièces) — retour direct de l'utilisateur après
un premier essai en Voronoi directe. Attention à deux pièges qui ont fait
foirer les premières tentatives :

- Les points de padding (hors des `piece_count` points réels, nécessaires
  pour que les cellules Voronoi soient bornées) doivent être STRICTEMENT
  en dehors du carré unité (anneau à rayon fixe) — un tirage aléatoire
  genre `uniform(-0.5, 1.5)` peut placer un point de padding EN PLEIN DANS
  le carré, qui vole alors du territoire aux vrais points (cellules
  biscornues ET trous de couverture une fois les groupes fusionnés).
- L'adjacence entre cellules pour la croissance de région doit être
  calculée sur la géométrie APRÈS clipping (intersection réelle des
  polygones), pas sur `vor.ridge_points` (adjacence du diagramme Voronoi
  infini, avant clipping) — deux cellules voisines dans le diagramme
  infini peuvent ne plus se toucher du tout une fois coupées au carré,
  ce qui produit des groupes disjoints (union en `MultiPolygon`) et donc
  des trous si on ne garde que le plus gros fragment.

Déterminisme : tout est seedé sur media_id (+ un suffixe dédié pour l'ordre
de révélation), donc reproductible même sans cache — mais le whitepaper
(§5.2) exige explicitement un cache par media_id (éviter de recalculer à
chaque chargement), d'où la persistance dans CardFragments.
"""
import json
import math
import random

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree
from sqlmodel import Session, select

from models import CardFragments, MemeCard

UNIT_SQUARE = box(0.0, 0.0, 1.0, 1.0)

# Nombre de cellules du maillage fin, indépendant de piece_count — juste
# assez de granularité pour un rendu organique sans exploser le temps de
# calcul (reste de l'ordre de la seconde même pour piece_count=24).
_MIN_FINE_CELLS = 30
_FINE_CELLS_PER_PIECE = 5
_RING_POINTS = 20
_RING_RADIUS = 2.0  # bien au-delà de la diagonale du carré unité (~0.71)


def _seed_points(rng: random.Random, n: int) -> np.ndarray:
    pts = [(rng.uniform(0, 1), rng.uniform(0, 1)) for _ in range(n)]
    for i in range(_RING_POINTS):
        angle = 2 * math.pi * i / _RING_POINTS
        pts.append((0.5 + _RING_RADIUS * math.cos(angle), 0.5 + _RING_RADIUS * math.sin(angle)))
    pts += [(-20, -20), (21, -20), (-20, 21), (21, 21)]
    return np.array(pts)


def _fine_cells(media_id: str, n: int) -> tuple[dict[int, Polygon], random.Random]:
    rng = random.Random(media_id)
    points = _seed_points(rng, n)
    vor = Voronoi(points)

    cells: dict[int, Polygon] = {}
    for point_idx in range(n):
        region_idx = vor.point_region[point_idx]
        region = vor.regions[region_idx]
        if not region or -1 in region:
            # Cellule non bornée (rare avec l'anneau de padding) — petit
            # carré de repli plutôt que de planter tout le calcul.
            x, y = points[point_idx]
            cell = box(x - 0.03, y - 0.03, x + 0.03, y + 0.03)
        else:
            verts = [vor.vertices[i] for i in region]
            cell = Polygon(verts)
        clipped = cell.intersection(UNIT_SQUARE)
        if not clipped.is_empty:
            cells[point_idx] = clipped

    return cells, rng


def _true_adjacency(cells: dict[int, Polygon]) -> dict[int, set[int]]:
    """
    Adjacence calculée sur la géométrie APRÈS clipping — voir l'avertissement
    en tête de fichier sur pourquoi `vor.ridge_points` ne suffit pas.
    """
    ids = list(cells.keys())
    geoms = [cells[i] for i in ids]
    tree = STRtree(geoms)
    adjacency: dict[int, set[int]] = {i: set() for i in ids}
    for idx, i in enumerate(ids):
        for cidx in tree.query(geoms[idx]):
            j = ids[cidx]
            if j == i:
                continue
            if geoms[idx].intersection(cells[j]).length > 1e-9:  # vraie arête partagée, pas juste un point
                adjacency[i].add(j)
                adjacency[j].add(i)
    return adjacency


def _merge_into_pieces(media_id: str, piece_count: int) -> list[list[list[float]]]:
    base_n = max(_MIN_FINE_CELLS, piece_count * _FINE_CELLS_PER_PIECE)
    cells, rng = _fine_cells(media_id, base_n)
    adjacency = _true_adjacency(cells)

    all_ids = list(cells.keys())
    rng.shuffle(all_ids)
    seeds = all_ids[:piece_count]
    groups: list[set[int]] = [{s} for s in seeds]
    claimed = set(seeds)
    frontiers = [set(adjacency[s]) - claimed for s in seeds]

    unclaimed = set(cells.keys()) - claimed
    while unclaimed:
        progressed = False
        for gi in range(piece_count):
            frontiers[gi] -= claimed
            if not frontiers[gi]:
                continue
            pick = frontiers[gi].pop()
            if pick in claimed:
                continue
            groups[gi].add(pick)
            claimed.add(pick)
            unclaimed.discard(pick)
            frontiers[gi] |= adjacency[pick] - claimed
            progressed = True
        if not progressed and unclaimed:
            # Poche isolée (aucune arête vive vers un groupe existant) :
            # rattachée au groupe d'un voisin direct dans le graphe — garde
            # la connexité (donc un union simple, pas un MultiPolygon).
            for pid in list(unclaimed):
                for gi, g in enumerate(groups):
                    if adjacency[pid] & g:
                        groups[gi].add(pid)
                        claimed.add(pid)
                        unclaimed.discard(pid)
                        break

    polygons: list[list[list[float]]] = []
    for g in groups:
        merged = unary_union([cells[i] for i in g])
        if merged.geom_type != "Polygon":
            # Ne devrait plus arriver (adjacence post-clipping garantit la
            # connexité) — filet de sécurité plutôt qu'un crash en prod.
            merged = max(merged.geoms, key=lambda p: p.area)
        coords = list(merged.exterior.coords)
        polygons.append([[round(x, 5), round(y, 5)] for x, y in coords])

    return polygons


def get_or_generate_fragments(session: Session, media_id: str, tier: str, piece_count: int) -> CardFragments:
    existing = session.get(CardFragments, media_id)
    if existing is not None and existing.piece_count == piece_count:
        return existing

    polygons = _merge_into_pieces(media_id, piece_count)
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
