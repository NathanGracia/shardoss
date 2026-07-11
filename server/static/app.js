'use strict';

const MEMOSS_ORIGIN = 'https://memoss.nathangracia.com';
const TIER_LABELS = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

let mediaMetaCache = new Map();
let currentCollection = null;
let activeFilter = 'all';
const tierCursorKey = 'shardoss_tier_cursor';
const memeVolumeKey = 'shardoss_meme_volume';

function getMemeVolume() {
  const v = parseFloat(localStorage.getItem(memeVolumeKey));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.15;
}

// Une seule vidéo à la fois joue du son (survoler une nouvelle carte coupe
// le fondu de la précédente) — sinon plusieurs memes qui parlent en même
// temps en survolant vite la grille.
let audioFadeVideo = null;

// setInterval plutôt que requestAnimationFrame : une chaîne de rAF relancée
// depuis un handler d'événement souris "trusted" (un vrai survol, pas un
// événement synthétique) s'est avérée ne jamais avancer dans certains
// contextes (volume bloqué à 0 en boucle, vérifié à la trace) — setInterval
// est un minuteur indépendant de la boucle de rendu et n'a pas ce problème.
function fadeVideoVolume(video, target, duration = 250) {
  if (video._fadeInterval) clearInterval(video._fadeInterval);
  const start = video.volume;
  const startTime = Date.now();
  if (target > 0) video.muted = false;
  video._fadeInterval = setInterval(() => {
    const t = Math.min((Date.now() - startTime) / duration, 1);
    video.volume = start + (target - start) * t;
    if (t >= 1) {
      clearInterval(video._fadeInterval);
      video._fadeInterval = null;
      if (target === 0) video.muted = true;
    }
  }, 16);
}

function hoverInMemeAudio(video) {
  if (audioFadeVideo && audioFadeVideo !== video) fadeVideoVolume(audioFadeVideo, 0);
  audioFadeVideo = video;
  const volume = getMemeVolume();
  fadeVideoVolume(video, volume);
  // La musique baisse de moitié pendant que le son du meme se fait entendre
  // — inutile si le son des memes est lui-même coupé (rien à mettre en avant).
  if (volume > 0) duckMusic();
}

function hoverOutMemeAudio(video) {
  if (audioFadeVideo === video) audioFadeVideo = null;
  fadeVideoVolume(video, 0);
  restoreMusic();
}

function setupMemeVolumeControl() {
  const slider = document.getElementById('meme-volume-slider');
  const icon = document.getElementById('meme-volume-icon');
  if (!slider) return;
  const volume = getMemeVolume();
  slider.value = volume;
  icon.textContent = volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    localStorage.setItem(memeVolumeKey, v);
    icon.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    // Applique en direct si une carte est en train de fondre le son.
    if (audioFadeVideo) fadeVideoVolume(audioFadeVideo, v, 60);
  });
}

// ── Musique de fond ────────────────────────────────────────────────────────
const musicVolumeKey = 'shardoss_music_volume';
const MUSIC_TRACKS = [
  'music/alps-journey.mp3',
  'music/hanging-on-the-mont-blanc.mp3',
  'music/into-the-steep.mp3',
];

function getMusicVolume() {
  const v = parseFloat(localStorage.getItem(musicVolumeKey));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.15;
}

// Référence posée par setupBackgroundMusic() — lue par hoverIn/OutMemeAudio
// pour baisser (« duck ») la musique pendant qu'un meme se fait entendre.
let bgMusicAudio = null;

function duckMusic() {
  if (!bgMusicAudio) return;
  fadeVideoVolume(bgMusicAudio, getMusicVolume() * 0.5);
}

function restoreMusic() {
  if (!bgMusicAudio) return;
  fadeVideoVolume(bgMusicAudio, getMusicVolume());
}

function setupBackgroundMusic() {
  const audio = document.getElementById('bg-music');
  const slider = document.getElementById('music-volume-slider');
  const icon = document.getElementById('music-volume-icon');
  if (!audio || !slider) return;
  bgMusicAudio = audio;

  // Ordre mélangé une fois par chargement de page, puis on boucle dessus —
  // pas de tirage aléatoire à chaque morceau (sinon le même titre peut
  // repasser juste après avoir été entendu).
  const order = [...MUSIC_TRACKS.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let pos = 0;

  function playAt(p) {
    audio.src = MUSIC_TRACKS[order[p]];
    audio.play().catch(() => {});
  }

  audio.addEventListener('ended', () => {
    pos = (pos + 1) % order.length;
    playAt(pos);
  });

  const volume = getMusicVolume();
  audio.volume = volume;
  slider.value = volume;
  icon.textContent = volume === 0 ? '🔇' : '🎵';

  if (volume > 0) playAt(pos);

  // L'autoplay avec son est généralement bloqué tant que la page n'a reçu
  // aucun geste utilisateur — filet de secours, on retente au premier clic.
  document.addEventListener('pointerdown', () => {
    if (audio.paused && getMusicVolume() > 0) audio.play().catch(() => {});
  }, { once: true });

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    localStorage.setItem(musicVolumeKey, v);
    audio.volume = v;
    icon.textContent = v === 0 ? '🔇' : '🎵';
    if (v === 0) {
      audio.pause();
    } else if (audio.paused) {
      if (!audio.src) playAt(pos);
      else audio.play().catch(() => {});
    }
  });
}

// La grille de collection charge une vidéo autoplay par carte touchée — au
// delà d'une trentaine de cartes, les avoir TOUTES en lecture simultanée
// fait chuter les perfs (décodage vidéo concurrent, pas juste du DOM).
// Le whitepaper limitait déjà le chargement aux seules cartes touchées
// (jamais les ~200 médias de la galerie), mais même ce sous-ensemble grossit
// avec le temps. Plutôt que de la pagination (casse la sensation de
// "parcourir sa collection"), un IntersectionObserver partagé ne charge/
// joue que les vidéos réellement visibles (± une marge de pré-chargement),
// et met en pause (sans décharger, pour un retour instantané au scroll)
// celles qui sortent de l'écran.
const videoObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting) {
        if (!video.src && video.dataset.src) video.src = video.dataset.src;
        video.play().catch(() => {});
      } else {
        video.pause();
        // Un scroll peut faire sortir la carte de sous le curseur sans que
        // la souris bouge — mouseleave ne se déclenche alors jamais. Sans
        // ça, la vidéo reviendrait à l'écran encore audible au prochain
        // scroll, sans survol réel.
        if (video._fadeInterval) clearInterval(video._fadeInterval);
        video.muted = true;
        video.volume = 0;
        if (audioFadeVideo === video) audioFadeVideo = null;
      }
    }
  },
  { rootMargin: '400px 0px' }
);

async function fetchMediaMeta(mediaId) {
  if (mediaMetaCache.has(mediaId)) return mediaMetaCache.get(mediaId);
  try {
    const r = await fetch(`${MEMOSS_ORIGIN}/api/media/${mediaId}`);
    const meta = r.ok ? await r.json() : null;
    mediaMetaCache.set(mediaId, meta);
    return meta;
  } catch (_) {
    return null;
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderEconomyBar(state) {
  const el = document.getElementById('economy-bar');
  el.innerHTML = `
    <div class="dolloss-pill">
      <span class="dolloss-dot"></span>
      <span class="dolloss-value hf-mono" id="dolloss-value">${Math.floor(state.dolloss).toLocaleString('fr-FR')}</span>
      <span class="dolloss-label hf-cond">DOLLOSS</span>
    </div>
    <button class="booster-buy" id="booster-buy-btn">+ ACHETER UN BOOSTER</button>
  `;
  document.getElementById('booster-buy-btn').addEventListener('click', openBoosterModal);
}

async function openBoosterModal() {
  const modal = document.getElementById('booster-modal');
  const subtitle = document.getElementById('booster-modal-subtitle');
  const okBtn = document.getElementById('booster-modal-ok');
  document.getElementById('booster-modal-card').className = 'modal-card modal-card--wide';
  subtitle.textContent = 'BOOSTERS DISPONIBLES';
  okBtn.textContent = 'FERMER';
  modal.hidden = false;
  await renderBoosterSelection();
}

async function renderBoosterSelection() {
  const body = document.getElementById('booster-modal-body');
  body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.5)" class="hf-mono">Chargement…</div>`;
  try {
    const r = await fetch('/api/boosters/prices');
    if (!r.ok) throw new Error('prices fetch failed');
    const prices = await r.json();

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${Object.entries(prices).map(([type, info]) => `
          <div class="booster-option">
            <div class="booster-option-icon hf-mono" data-type="${type}"><span>PACK</span></div>
            <div class="booster-option-label tier-badge ${type} hf-cond">${info.label}</div>
            <div class="hf-mono" style="font-size:12px;color:rgba(16,22,28,.5)">${info.shards} shards</div>
            <div class="hf-mono" style="font-size:17px;font-weight:500;color:var(--ink)">${Math.ceil(info.price)} <span style="font-size:11px;color:rgba(16,22,28,.4)">DOLLOSS</span></div>
            <button class="booster-option-buy hf-cond" data-type="${type}">ACHETER</button>
          </div>
        `).join('')}
      </div>
    `;
    body.querySelectorAll('.booster-option-buy').forEach((btn) => {
      btn.addEventListener('click', () => buyAndRevealBooster(btn.dataset.type));
    });

    // Vignette du pack : un meme au hasard de la rareté correspondante,
    // chargé après coup (pas bloquant pour l'affichage des prix/boutons).
    Object.entries(prices).forEach(async ([type, info]) => {
      if (!info.thumbnail_media_id) return;
      const meta = await fetchMediaMeta(info.thumbnail_media_id);
      if (!meta) return;
      const icon = body.querySelector(`.booster-option-icon[data-type="${type}"]`);
      if (!icon) return;
      const video = document.createElement('video');
      video.src = `${MEMOSS_ORIGIN}${meta.url}`;
      video.muted = true;
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      icon.innerHTML = '';
      icon.appendChild(video);
    });
  } catch (_) {
    body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Impossible de charger les boosters.</div>`;
  }
}

async function buyAndRevealBooster(boosterType) {
  const body = document.getElementById('booster-modal-body');
  const okBtn = document.getElementById('booster-modal-ok');
  body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.5)" class="hf-mono">Ouverture…</div>`;
  try {
    const r = await fetch('/api/boosters/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booster_type: boosterType }),
    });
    if (r.status === 402) {
      body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Solde de Dolloss insuffisant.</div>`;
      return;
    }
    if (!r.ok) throw new Error('booster buy failed');
    const data = await r.json();
    document.getElementById('dolloss-value').textContent = Math.floor(data.dolloss).toLocaleString('fr-FR');

    if (!data.results.length) {
      body.innerHTML = '<div class="empty-state">Aucune carte disponible — recalcul quotidien pas encore lancé.</div>';
      okBtn.textContent = 'TERMINER';
      await loadCollection();
      return;
    }

    renderPackTap(data.results);
  } catch (_) {
    body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Erreur pendant l'ouverture.</div>`;
  }
}

function renderPackTap(results) {
  const body = document.getElementById('booster-modal-body');
  body.innerHTML = `<div style="text-align:center;padding:36px 0">
    <div class="booster-pack" id="booster-pack-trigger">
      <div class="booster-pack-shine"></div>
      <div class="booster-pack-logo hf-cond">SHARDOSS</div>
      <div class="booster-pack-tap hf-mono">TAP TO OPEN</div>
    </div>
  </div>`;
  document.getElementById('booster-pack-trigger').addEventListener('click', () => renderShardBacks(results), { once: true });
}

// Gradients "possédé" par tier, repris du mockup (TIER_META.ownedBg) — le
// legendary n'y était pas (aucun des 3 exemples du mockup n'était
// legendary), extrapolé en mélange orange/cyan pour rester cohérent avec
// le badge dual-tone du tier. Utilisé seulement en repli si aucune vidéo
// n'a pu être chargée pour l'éclat.
const TIER_REVEAL_BG = {
  common: 'linear-gradient(160deg,#eef1f3,#dbe1e5)',
  rare: 'linear-gradient(160deg,#cdeaf2,#a9d9e6)',
  epic: 'linear-gradient(160deg,#ffd8c2,#ffb083)',
  legendary: 'linear-gradient(160deg,#ffe1c2,#c9ecf5)',
};

// Les points d'un éclat sont stockés dans le référentiel de la carte ENTIÈRE
// (0..1 sur toute la carte) — un éclat positionné dans un coin de la carte
// n'occupe donc qu'une petite fraction de cet espace. Les normaliser à leur
// propre boîte englobante avant de les utiliser comme clip-path, sinon
// chaque éclat apparaît à une taille/position différente au lieu de
// remplir uniformément sa case dans la rangée de révélation.
function pieceBBox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function normalizedClipPath(points, bbox) {
  const w = bbox.maxX - bbox.minX || 1;
  const h = bbox.maxY - bbox.minY || 1;
  return `polygon(${points.map(([x, y]) => `${((x - bbox.minX) / w * 100).toFixed(2)}% ${((y - bbox.minY) / h * 100).toFixed(2)}%`).join(', ')})`;
}

// Positionne/dimensionne une vidéo pour qu'elle remplisse tout le conteneur
// EN NE MONTRANT QUE la fenêtre correspondant à la bbox de cet éclat — même
// principe qu'un sprite recadré : la vidéo est agrandie d'un facteur
// 1/largeur_bbox (resp. hauteur) et décalée pour que la zone voulue tombe
// pile dans le cadre visible (le clip-path posé sur le parent découpe
// ensuite la vraie silhouette dans cette fenêtre).
function cropVideoToBBox(video, bbox) {
  const w = bbox.maxX - bbox.minX || 1;
  const h = bbox.maxY - bbox.minY || 1;
  video.style.width = `${100 / w}%`;
  video.style.height = `${100 / h}%`;
  video.style.left = `${(-bbox.minX / w) * 100}%`;
  video.style.top = `${(-bbox.minY / h) * 100}%`;
}

function renderShardBacks(results) {
  document.getElementById('booster-modal-card').className = 'modal-card modal-card--reveal';
  const body = document.getElementById('booster-modal-body');
  const okBtn = document.getElementById('booster-modal-ok');
  okBtn.textContent = 'TERMINER';

  body.innerHTML = `<div class="shard-reveal-row">
    ${results.map((res, i) => {
      // La silhouette exacte de l'éclat qui va apparaître sur la carte est
      // déjà connue (calculée côté serveur pendant l'achat) — le dos
      // "mystère" prend directement cette forme au lieu d'un losange
      // générique, pour ne pas changer de silhouette au moment du clic.
      let clipStyle = '';
      if (res.newly_revealed_points) {
        clipStyle = ` style="clip-path:${normalizedClipPath(res.newly_revealed_points, pieceBBox(res.newly_revealed_points))}"`;
      }
      // .shard-glow porte le MÊME clip-path que l'éclat : agrandi + flouté,
      // ça donne une lueur qui épouse le contour réel de l'éclat plutôt
      // qu'un cercle générique posé derrière.
      return `
        <div class="shard-back${res.tier === 'legendary' ? ' legendary' : ''}" id="shard-back-${i}" style="--glow: var(--tier-${res.tier}-bracket)">
          <div class="shard-visual">
            <div class="shard-glow"${clipStyle}></div>
            <div class="shard-back-inner hf-mono"${clipStyle}>?</div>
          </div>
        </div>
      `;
    }).join('')}
  </div>`;

  results.forEach((res, i) => {
    document.getElementById(`shard-back-${i}`).addEventListener(
      'click',
      () => revealShard(i, res),
      { once: true }
    );
  });
}

async function revealShard(index, res) {
  const slot = document.getElementById(`shard-back-${index}`);
  slot.classList.add('revealing');

  const meta = await fetchMediaMeta(res.media_id);
  const videoUrl = meta ? `${MEMOSS_ORIGIN}${meta.url}` : '';
  const bbox = res.newly_revealed_points ? pieceBBox(res.newly_revealed_points) : null;

  slot.classList.remove('revealing');
  slot.classList.add('revealed');

  const mediaWrap = document.createElement('div');
  mediaWrap.className = 'shard-back-media';
  if (bbox) mediaWrap.style.clipPath = normalizedClipPath(res.newly_revealed_points, bbox);

  if (videoUrl && bbox) {
    // Uniquement le morceau de vidéo visible à travers la silhouette de cet
    // éclat — pas la carte entière — et elle continue de jouer en boucle.
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    cropVideoToBBox(video, bbox);
    mediaWrap.appendChild(video);
  } else {
    mediaWrap.style.background = TIER_REVEAL_BG[res.tier] || TIER_REVEAL_BG.common;
  }

  // On ne vide QUE .shard-visual (dos mystère → média révélé) : la lueur
  // vit dans ce même conteneur et garde exactement le même clip-path
  // (l'éclat ne change pas de silhouette entre mystère et révélé).
  const visual = slot.querySelector('.shard-visual');
  visual.innerHTML = '';
  const glow = document.createElement('div');
  glow.className = 'shard-glow';
  if (bbox) glow.style.clipPath = normalizedClipPath(res.newly_revealed_points, bbox);
  visual.appendChild(glow);
  visual.appendChild(mediaWrap);

  const info = document.createElement('div');
  info.className = 'shard-back-info';
  info.innerHTML = `
    <span class="tier-badge ${res.tier} hf-cond">${TIER_LABELS[res.tier] || res.tier}</span>
    <span class="hf-mono" style="font-size:12px;color:rgba(16,22,28,.5)">${res.overflow_to_dolloss ? `+${res.overflow_to_dolloss} Dolloss (doublon)` : `+${res.shard_applied} shard`}</span>
  `;
  slot.appendChild(info);

  // Après 2s, la carte complète apparaît et l'éclat "rentre" dedans : vidéo
  // non recadrée + vrai puzzle de la carte, à la place du gros plan
  // recadré sur ce seul éclat.
  setTimeout(() => assembleCard(slot, res, videoUrl), 2000);

  const allRevealed = document.querySelectorAll('.shard-back:not(.revealed)').length === 0;
  if (allRevealed) await loadCollection();
}

async function assembleCard(slot, res, videoUrl) {
  slot.classList.add('assembled');
  const mediaWrap = slot.querySelector('.shard-back-media');
  if (!mediaWrap) return;

  let fragmentsHtml = '';
  try {
    const r = await fetch(`/api/collection/${res.media_id}/fragments`);
    if (r.ok) fragmentsHtml = buildShatterSvg(await r.json());
  } catch (_) { /* pas bloquant, la carte s'affiche quand même sans le puzzle */ }

  mediaWrap.innerHTML = '';
  mediaWrap.style.background = '';
  if (videoUrl) {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    mediaWrap.appendChild(video);
  }
  mediaWrap.insertAdjacentHTML('beforeend', fragmentsHtml);

  const band = document.createElement('div');
  band.className = 'meme-card-band';
  band.innerHTML = `
    <span class="pps hf-mono">${res.points_per_sec.toFixed(1)} PTS/S</span>
    <span class="tier-badge ${res.tier} hf-cond">${TIER_LABELS[res.tier] || res.tier}</span>
    <span class="mult hf-mono">×${res.quality_multiplier.toFixed(2)}</span>
  `;
  const info = slot.querySelector('.shard-back-info');
  if (info) info.replaceWith(band);
}

function buildShatterSvg(fragments) {
  // Palette semi-transparente (pas opaque) : les éclats non révélés
  // laissent deviner la vidéo en dessous plutôt que la masquer complètement.
  const palette = ['rgba(231,237,241,.82)', 'rgba(219,228,234,.82)', 'rgba(238,243,246,.82)', 'rgba(211,221,227,.82)', 'rgba(226,233,238,.82)'];
  const stroke = 'rgba(255,255,255,.85)';
  const polys = fragments.pieces
    .map((p, i) => {
      const points = p.points.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' ');
      if (p.revealed) {
        return `<polygon points="${points}" fill="transparent" stroke="${stroke}" stroke-width="0.5"></polygon>`;
      }
      const fill = palette[i % palette.length];
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="0.5"></polygon>`;
    })
    .join('');
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${polys}</svg>`;
}

function setupLoopPop(video, mediaEl, pointsPerSec) {
  // Pas d'attribut `loop` natif : avec `loop`, l'event `ended` ne se
  // déclenche jamais côté navigateur. On boucle manuellement pour pouvoir
  // accrocher le "pop" de gain à chaque fin de boucle réelle (whitepaper §5.1).
  video.addEventListener('ended', () => {
    const duration = video.duration || 0;
    const gain = Math.round(duration * pointsPerSec);
    const counter = mediaEl.querySelector('.pop-counter');
    if (counter) {
      counter.textContent = `+${gain}`;
      counter.classList.add('show');
      setTimeout(() => counter.classList.remove('show'), 900);
    }
    video.currentTime = 0;
    video.play().catch(() => {});
  });
}

async function renderCard(cardData) {
  const el = document.createElement('div');
  el.className = 'meme-card';

  const mediaEl = document.createElement('div');
  mediaEl.className = 'meme-card-media';

  const bracketTl = document.createElement('div');
  bracketTl.className = 'bracket tl';
  bracketTl.style.borderColor = `var(--tier-${cardData.tier}-bracket)`;
  const bracketTr = document.createElement('div');
  bracketTr.className = 'bracket tr';
  bracketTr.style.borderColor = `var(--tier-${cardData.tier}-bracket)`;
  mediaEl.appendChild(bracketTl);
  mediaEl.appendChild(bracketTr);

  const meta = await fetchMediaMeta(cardData.media_id);
  const videoUrl = meta ? `${MEMOSS_ORIGIN}${meta.url}` : '';

  const video = document.createElement('video');
  video.dataset.src = videoUrl; // src posé par videoObserver seulement quand la carte devient visible
  video.muted = true;
  video.volume = 0; // le fondu au survol part toujours de 0, jamais d'un pic à pleine puissance
  video.playsInline = true;
  video.preload = 'none';
  mediaEl.appendChild(video);
  videoObserver.observe(video);
  mediaEl.addEventListener('mouseenter', () => hoverInMemeAudio(video));
  mediaEl.addEventListener('mouseleave', () => hoverOutMemeAudio(video));

  // Le toast "+N" ne veut rien dire tant que la carte n'est pas
  // déverrouillée : seules les cartes unlocked comptent dans la somme des
  // points_per_sec qui alimente le Dolloss côté serveur (sum_points_per_sec
  // filtre unlocked=True) — l'afficher sur une carte verrouillée annonce un
  // gain qui n'est jamais réellement crédité.
  let popCounter = null;
  if (cardData.unlocked) {
    popCounter = document.createElement('div');
    popCounter.className = 'pop-counter';
    popCounter.textContent = '+0';
    mediaEl.appendChild(popCounter);
  }

  el.appendChild(mediaEl);

  const band = document.createElement('div');
  band.className = 'meme-card-band';
  band.innerHTML = `
    <span class="pps hf-mono">${cardData.points_per_sec.toFixed(1)} PTS/S</span>
    <span class="tier-badge ${cardData.tier} hf-cond">${TIER_LABELS[cardData.tier] || cardData.tier}</span>
    <span class="mult hf-mono">×${cardData.quality_multiplier.toFixed(2)}</span>
  `;
  el.appendChild(band);

  if (cardData.unlocked) {
    // Rebouclage manuel (pas l'attribut natif) pour pouvoir accrocher le
    // "pop" de gain exactement à la fin de chaque boucle réelle.
    setupLoopPop(video, mediaEl, cardData.points_per_sec);
  } else {
    // Pas de toast à afficher ici : l'attribut natif suffit pour boucler.
    video.loop = true;
  }

  if (!cardData.unlocked) {
    // La vidéo reste visible : les éclats "révélés" du puzzle sont
    // transparents et laissent voir la vidéo en dessous (§5.2 du
    // whitepaper — chaque shard obtenue révèle un morceau de la carte,
    // pas rien). Seuls les éclats non révélés (gris opaque) la cachent.
    const pill = document.createElement('div');
    pill.className = 'locked-pill hf-mono';
    pill.textContent = 'VERROUILLÉ';
    mediaEl.insertBefore(pill, popCounter);
    try {
      const r = await fetch(`/api/collection/${cardData.media_id}/fragments`);
      if (r.ok) {
        const fragments = await r.json();
        mediaEl.insertAdjacentHTML('beforeend', buildShatterSvg(fragments));
      }
    } catch (_) { /* pas bloquant pour l'affichage de la vidéo */ }
  }

  const shardCount = document.createElement('div');
  shardCount.className = 'shard-count hf-mono';
  shardCount.textContent = `${cardData.shards_owned}/${cardData.shards_required} SHARDS`;
  el.appendChild(shardCount);

  return el;
}

async function renderGrid() {
  const grid = document.getElementById('card-grid');
  // Change de filtre = la grille précédente va être jetée : détache ses
  // vidéos de l'observer plutôt que de laisser des références à des
  // éléments hors DOM s'accumuler dedans.
  grid.querySelectorAll('video').forEach((v) => videoObserver.unobserve(v));

  const cards = activeFilter === 'all'
    ? currentCollection.cards
    : currentCollection.cards.filter((c) => c.tier === activeFilter);

  if (!cards.length) {
    grid.innerHTML = `<div class="empty-state">${
      currentCollection.cards.length ? 'Aucune carte dans ce tier.' : 'Joue une partie de Memoss pour commencer ta collection.'
    }</div>`;
    return;
  }
  // Chaque renderCard() fait plusieurs fetch async (meta média, fragments) —
  // les résoudre en parallèle mais les insérer dans l'ordre d'origine du
  // tableau, sinon l'ordre d'arrivée réseau détermine l'ordre à l'écran et
  // les cartes semblent se réarranger à chaque rechargement.
  const elements = await Promise.all(cards.map((cardData) => renderCard(cardData)));
  grid.innerHTML = '';
  elements.forEach((el) => grid.appendChild(el));
}

function setupFilterTabs() {
  document.querySelectorAll('.filter-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.tier;
      renderGrid();
    });
  });
}

async function loadCollection() {
  const r = await fetch('/api/collection');
  if (r.status === 401) {
    document.getElementById('card-grid').innerHTML =
      '<div class="empty-state">Connecte-toi pour voir ta collection.</div>';
    return;
  }
  currentCollection = await r.json();
  renderEconomyBar(currentCollection);
  document.getElementById('shards-held').textContent =
    `${currentCollection.cards.reduce((sum, c) => sum + c.shards_owned, 0)} SHARDS DÉTENUS`;
  renderGrid();
}

function renderTierNotifications(changes) {
  const modal = document.getElementById('tier-modal');
  const body = document.getElementById('tier-modal-body');
  body.innerHTML = changes.map((c) => `
    <div class="tier-change-row">
      <div class="tier-change-thumb hf-mono" style="font-size:8px;letter-spacing:.06em;color:rgba(16,22,28,.5)">GIF</div>
      <div class="tier-change-name">${esc(c.media_id.slice(0, 12))}…</div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="tier-badge ${c.old_tier || 'common'} hf-cond">${TIER_LABELS[c.old_tier] || '?'}</span>
        <span class="tier-change-arrow">→</span>
        <span class="tier-badge ${c.new_tier} hf-cond">${TIER_LABELS[c.new_tier] || c.new_tier}</span>
      </div>
    </div>
  `).join('');
  modal.hidden = false;
}

async function pollTierNotifications() {
  const since = localStorage.getItem(tierCursorKey);
  const qs = since ? `?since_id=${encodeURIComponent(since)}` : '';
  try {
    const r = await fetch(`/api/tiers/notifications${qs}`);
    if (!r.ok) return;
    const data = await r.json();
    if (data.changes && data.changes.length) {
      renderTierNotifications(data.changes);
    }
    localStorage.setItem(tierCursorKey, String(data.latest_id));
  } catch (_) { /* silencieux */ }
}

(async function init() {
  setupFilterTabs();
  setupMemeVolumeControl();
  setupBackgroundMusic();

  document.getElementById('booster-modal-close').addEventListener('click', () => {
    document.getElementById('booster-modal').hidden = true;
  });
  document.getElementById('booster-modal-ok').addEventListener('click', () => {
    document.getElementById('booster-modal').hidden = true;
  });
  document.getElementById('tier-modal-close').addEventListener('click', () => {
    document.getElementById('tier-modal').hidden = true;
  });
  document.getElementById('tier-modal-ok').addEventListener('click', () => {
    document.getElementById('tier-modal').hidden = true;
  });

  await AccountWidget.load();
  AccountWidget.mount('account-widget');
  if (AccountWidget.session.loggedIn) {
    await loadCollection();
    pollTierNotifications();
    setInterval(pollTierNotifications, 60000);
  } else {
    document.getElementById('card-grid').innerHTML =
      '<div class="empty-state">Connecte-toi pour voir ta collection.</div>';
  }

  // Overlay de debug optionnel (?debugvideos dans l'URL) : confirme à l'œil
  // que les vidéos hors-écran sont bien en pause, sans avoir à ouvrir les
  // DevTools pour le vérifier à chaque fois.
  if (location.search.includes('debugvideos')) {
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:12px;right:12px;background:rgba(16,22,28,.85);color:#7ee9b0;font:12px \'IBM Plex Mono\',monospace;padding:8px 12px;border-radius:8px;z-index:9999;pointer-events:none';
    document.body.appendChild(badge);
    setInterval(() => {
      const videos = document.querySelectorAll('.card-grid video');
      const withSrc = [...videos].filter((v) => v.src).length;
      const playing = [...videos].filter((v) => v.src && !v.paused).length;
      badge.textContent = `vidéos: ${videos.length} total · ${withSrc} chargées · ${playing} en lecture`;
    }, 500);
  }
})();
