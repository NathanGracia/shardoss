'use strict';

const MEMOSS_ORIGIN = 'https://memoss.nathangracia.com';
const TIER_LABELS = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
// Ordre d'affichage par défaut de la grille : du plus rare au plus commun.
const TIER_ORDER = ['legendary', 'epic', 'rare', 'common'];

let mediaMetaCache = new Map();
let currentCollection = null;
let activeFilter = 'all';
const tierCursorKey = 'shardoss_tier_cursor';

// Toasts "+N" portés sur document.body (voir renderCard/setupLoopPop) —
// suivis ici pour être explicitement nettoyés avant un re-render de la
// grille, puisqu'ils ne sont pas des descendants de #card-grid.
const activePopCounters = new Set();

// ── Volume général ───────────────────────────────────────────────────────
// Un seul réglage, partagé avec Memoss/Blindtoss/cooloss via le compte
// (claims du token de session, voir cooloss/prisma/schema.prisma —
// User.volume). Un invité sans compte retombe sur un repli local.
const guestVolumeKey = 'shardoss_volume';
// Anciennes clés (avant l'unification cross-apps) — lues une seule fois en
// migration douce dans setupVolumeControl(), puis nettoyées.
const legacyMemeVolumeKey = 'shardoss_meme_volume';
const legacyMusicVolumeKey = 'shardoss_music_volume';

function getSharedVolume() {
  if (AccountWidget.session.loggedIn) return AccountWidget.session.volume;
  const v = parseFloat(localStorage.getItem(guestVolumeKey));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.15;
}

let _sharedVolumeDebounce = null;
function setSharedVolume(v) {
  // Reflété tout de suite en mémoire : les lectures qui suivent (hover,
  // musique) voient la nouvelle valeur sans attendre le PATCH réseau.
  AccountWidget.session.volume = v;
  if (AccountWidget.session.loggedIn) {
    if (_sharedVolumeDebounce) clearTimeout(_sharedVolumeDebounce);
    _sharedVolumeDebounce = setTimeout(() => {
      fetch('https://cooloss.nathangracia.com/api/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: v }),
      }).catch(() => {});
    }, 300);
  } else {
    localStorage.setItem(guestVolumeKey, v);
  }
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
  const volume = getSharedVolume();
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

// Référence posée par setupBackgroundMusic() — lue par hoverIn/OutMemeAudio
// pour baisser (« duck ») la musique pendant qu'un meme se fait entendre.
let bgMusicAudio = null;

function duckMusic() {
  if (!bgMusicAudio) return;
  fadeVideoVolume(bgMusicAudio, getSharedVolume() * 0.5);
}

function restoreMusic() {
  if (!bgMusicAudio) return;
  fadeVideoVolume(bgMusicAudio, getSharedVolume());
}

function setupVolumeControl() {
  const slider = document.getElementById('volume-slider');
  const icon = document.getElementById('volume-icon');
  if (!slider) return;

  // Migration douce, une seule fois : les deux anciennes clés (son des
  // memes / musique, désormais unifiées) servent de point de départ si le
  // réglage courant (compte ou invité) est encore vierge — pour ne pas
  // imposer 15% d'office à quelqu'un qui avait déjà réglé autre chose.
  const legacyRaw = localStorage.getItem(legacyMemeVolumeKey) ?? localStorage.getItem(legacyMusicVolumeKey);
  const legacy = legacyRaw !== null ? parseFloat(legacyRaw) : NaN;
  const hasLegacy = Number.isFinite(legacy) && legacy >= 0 && legacy <= 1;
  if (AccountWidget.session.loggedIn) {
    if (hasLegacy && AccountWidget.session.volume === 0.15) setSharedVolume(legacy);
  } else if (hasLegacy && localStorage.getItem(guestVolumeKey) === null) {
    localStorage.setItem(guestVolumeKey, String(legacy));
  }
  localStorage.removeItem(legacyMemeVolumeKey);
  localStorage.removeItem(legacyMusicVolumeKey);

  const volume = getSharedVolume();
  slider.value = volume;
  icon.textContent = volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    setSharedVolume(v);
    icon.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    // Applique en direct : le son du meme en cours de survol (s'il y en a
    // un) va au nouveau volume plein ; la musique reste à moitié si un
    // survol est en cours (ne casse pas le duck en cours), sinon au plein.
    if (audioFadeVideo) fadeVideoVolume(audioFadeVideo, v, 60);
    if (bgMusicAudio) fadeVideoVolume(bgMusicAudio, audioFadeVideo ? v * 0.5 : v, 60);
  });
}

// ── Musique de fond ────────────────────────────────────────────────────────
const MUSIC_TRACKS = [
  'music/alps-journey.mp3',
  'music/hanging-on-the-mont-blanc.mp3',
  'music/into-the-steep.mp3',
];

function setupBackgroundMusic() {
  const audio = document.getElementById('bg-music');
  if (!audio) return;
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

  const volume = getSharedVolume();
  audio.volume = volume;
  if (volume > 0) playAt(pos);

  // L'autoplay avec son est généralement bloqué tant que la page n'a reçu
  // aucun geste utilisateur — filet de secours, on retente au premier clic.
  document.addEventListener('pointerdown', () => {
    if (audio.paused && getSharedVolume() > 0) audio.play().catch(() => {});
  }, { once: true });
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
        video._shouldPlay = true;
        if (!video.src && video.dataset.src) video.src = video.dataset.src;
        video.play().catch(() => {});
      } else {
        video._shouldPlay = false;
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

// Le navigateur peut mettre une vidéo en pause EN INTERNE (jamais via
// video.pause() en JS, donc invisible pour tout code qui l'attendrait) —
// notamment quand hoverInMemeAudio() démute une vidéo qui autoplayait
// muette, sans geste utilisateur jugé suffisant. Sans filet, la vidéo reste
// figée indéfiniment sur sa dernière frame (vérifié en traçant les events
// 'pause' réels : ça arrive alors que .pause() n'est jamais appelé).
// video._shouldPlay (posé par videoObserver) distingue cette pause
// inattendue d'une pause légitime (carte sortie du viewport, fin de vidéo).
function attachPauseRetry(video) {
  video.addEventListener('pause', () => {
    if (video.ended || !video._shouldPlay) return;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  });
}

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

// ── Admin : loot tables ──────────────────────────────────────────────────
const ADMIN_BOOSTER_ORDER = ['common', 'rare', 'epic'];

// account-widget.js est partagé tel quel entre Memoss/Shardoss/Blindtoss
// (voir son en-tête) — on n'y touche pas pour un lien propre à Shardoss.
// Injecté après coup dans son dropdown, juste après le badge "Admin" déjà
// rendu par ce module quand isAdmin est vrai.
function addAdminMenuItem() {
  if (!AccountWidget.session.isAdmin) return;
  const menu = document.getElementById('account-widget-menu');
  if (!menu) return;
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = '⚙ Loot tables';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    menu.hidden = true;
    openAdminModal();
  });
  const badge = menu.querySelector('.account-widget-badge');
  if (badge) {
    badge.insertAdjacentElement('afterend', link);
  } else {
    menu.insertBefore(link, menu.firstChild);
  }
}

async function openAdminModal() {
  document.getElementById('admin-modal').hidden = false;
  await renderAdminForm();
}

async function renderAdminForm() {
  const body = document.getElementById('admin-modal-body');
  body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.5)" class="hf-mono">Chargement…</div>`;
  try {
    const r = await fetch('/api/admin/loot-config');
    if (!r.ok) throw new Error('fetch failed');
    const config = await r.json();

    body.innerHTML = `
      <div class="admin-section-title">RÉGLAGES GÉNÉRAUX</div>
      <div class="admin-field-grid">
        <div class="admin-field">
          <label>Croissance prix booster</label>
          <input type="number" step="0.01" min="1.001" id="admin-booster-price-growth" value="${config.booster_price_growth}">
        </div>
        <div class="admin-field">
          <label>Prix de base — shard cooloss</label>
          <input type="number" step="1" min="0" id="admin-cooloss-price-base" value="${config.cooloss_shard_price_base}">
        </div>
        <div class="admin-field">
          <label>Croissance prix — shard cooloss</label>
          <input type="number" step="0.01" min="1.001" id="admin-cooloss-price-growth" value="${config.cooloss_shard_price_growth}">
        </div>
        <div class="admin-field">
          <label>Chance de loot — shard cooloss (0 à 1)</label>
          <input type="number" step="0.01" min="0" max="1" id="admin-cooloss-loot-chance" value="${config.cooloss_shard_loot_chance}">
        </div>
      </div>
      ${ADMIN_BOOSTER_ORDER.filter((type) => config.boosters[type]).map((type) => {
        const b = config.boosters[type];
        return `
          <div class="admin-booster-box">
            <div class="admin-booster-box-title hf-cond">${esc(b.label)} (${type})</div>
            <div class="admin-field-grid">
              <div class="admin-field"><label>Label affiché</label><input type="text" id="admin-${type}-label" value="${esc(b.label)}"></div>
              <div class="admin-field"><label>Shards par ouverture</label><input type="number" step="1" min="1" max="20" id="admin-${type}-shards" value="${b.shards}"></div>
              <div class="admin-field"><label>Prix de base</label><input type="number" step="1" min="0" id="admin-${type}-price" value="${b.price_base}"></div>
            </div>
            <div class="admin-weights-label">POIDS DE TIRAGE PAR TIER (relatifs entre eux, pas besoin de sommer à 100)</div>
            <div class="admin-field-grid">
              <div class="admin-field"><label>Common</label><input type="number" step="1" min="0" id="admin-${type}-w-common" value="${b.weight_common}"></div>
              <div class="admin-field"><label>Rare</label><input type="number" step="1" min="0" id="admin-${type}-w-rare" value="${b.weight_rare}"></div>
              <div class="admin-field"><label>Epic</label><input type="number" step="1" min="0" id="admin-${type}-w-epic" value="${b.weight_epic}"></div>
              <div class="admin-field"><label>Legendary</label><input type="number" step="1" min="0" id="admin-${type}-w-legendary" value="${b.weight_legendary}"></div>
            </div>
          </div>
        `;
      }).join('')}
      <div class="admin-section-title">COULEURS DES TOASTS (SPECTRE DE GAIN)</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:rgba(16,22,28,.45);margin-bottom:10px">
        4 paliers, triés par seuil de gain croissant — la couleur appliquée au toast "+N" est celle du dernier palier dont le seuil est ≤ au gain affiché.
      </div>
      ${config.toast_color_stops.map((stop, i) => `
        <div class="admin-toast-stop">
          <span class="admin-toast-stop-label">SEUIL ${i + 1}</span>
          <input type="number" step="1" min="0" id="admin-toast-stop-${i}-threshold" value="${stop.threshold}">
          <input type="color" id="admin-toast-stop-${i}-color" value="${stop.color}">
        </div>
      `).join('')}
      <div id="admin-form-message"></div>
    `;
  } catch (_) {
    body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Impossible de charger les réglages.</div>`;
  }
}

async function saveAdminConfig() {
  const btn = document.getElementById('admin-modal-save');
  const payload = {
    booster_price_growth: parseFloat(document.getElementById('admin-booster-price-growth').value),
    cooloss_shard_price_base: parseFloat(document.getElementById('admin-cooloss-price-base').value),
    cooloss_shard_price_growth: parseFloat(document.getElementById('admin-cooloss-price-growth').value),
    cooloss_shard_loot_chance: parseFloat(document.getElementById('admin-cooloss-loot-chance').value),
    boosters: {},
    toast_color_stops: [0, 1, 2, 3].map((i) => ({
      threshold: parseFloat(document.getElementById(`admin-toast-stop-${i}-threshold`).value),
      color: document.getElementById(`admin-toast-stop-${i}-color`).value,
    })),
  };
  ADMIN_BOOSTER_ORDER.forEach((type) => {
    const labelEl = document.getElementById(`admin-${type}-label`);
    if (!labelEl) return;
    payload.boosters[type] = {
      label: labelEl.value,
      shards: parseInt(document.getElementById(`admin-${type}-shards`).value, 10),
      price_base: parseFloat(document.getElementById(`admin-${type}-price`).value),
      weight_common: parseInt(document.getElementById(`admin-${type}-w-common`).value, 10),
      weight_rare: parseInt(document.getElementById(`admin-${type}-w-rare`).value, 10),
      weight_epic: parseInt(document.getElementById(`admin-${type}-w-epic`).value, 10),
      weight_legendary: parseInt(document.getElementById(`admin-${type}-w-legendary`).value, 10),
    };
  });

  const msg = document.getElementById('admin-form-message');
  const prevBtnText = btn.textContent;
  btn.disabled = true;
  try {
    const r = await fetch('/api/admin/loot-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (msg) {
        msg.className = 'admin-error';
        msg.textContent = typeof err.detail === 'string' ? err.detail : 'Erreur de validation.';
      }
      return;
    }
    // Retour bien visible : le message en bas de modal peut être hors
    // champ dans un formulaire long — le libellé du bouton, lui, est
    // forcément sous les yeux au moment du clic.
    btn.textContent = '✓ ENREGISTRÉ';
    if (msg) {
      msg.className = 'admin-saved';
      msg.textContent = '✓ Réglages enregistrés — effectif immédiatement.';
    }
    setTimeout(() => {
      btn.textContent = prevBtnText;
      if (msg) msg.textContent = '';
    }, 2000);
  } catch (_) {
    if (msg) { msg.className = 'admin-error'; msg.textContent = 'Erreur réseau.'; }
  } finally {
    btn.disabled = false;
  }
}

function renderEconomyBar(state) {
  const el = document.getElementById('economy-bar');
  el.innerHTML = `
    <div class="dolloss-pill">
      <span class="dolloss-dot"></span>
      <span class="dolloss-value hf-mono" id="dolloss-value">${Math.floor(state.dolloss).toLocaleString('fr-FR')}</span>
      <span class="dolloss-label hf-cond">DOLLOSS</span>
      <span class="dolloss-rate hf-mono">+${(state.points_per_sec_total || 0).toFixed(1)}/S</span>
    </div>
    <div class="dolloss-pill cooloss-shard-pill" id="cooloss-shard-pill" title="Joker : permet de déverrouiller une shard sur n'importe quelle carte">
      <img class="cooloss-shard-icon-small" src="cooloss-shard.png" alt="">
      <span class="dolloss-value hf-mono" id="cooloss-shard-count">${state.cooloss_shards || 0}</span>
    </div>
    <button class="booster-buy" id="booster-buy-btn">+ ACHETER UN BOOSTER</button>
  `;
  document.getElementById('booster-buy-btn').addEventListener('click', openBoosterModal);
  // Point de départ pour animateDollossCounter() : évite de reparser le
  // texte formaté (espaces insécables fr-FR) au premier gain venant après
  // un (re)rendu complet de l'economy bar.
  document.getElementById('dolloss-value')._dollossDisplay = Math.floor(state.dolloss);
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
    const [pricesRes, coolossRes] = await Promise.all([
      fetch('/api/boosters/prices'),
      fetch('/api/cooloss-shard'),
    ]);
    if (!pricesRes.ok) throw new Error('prices fetch failed');
    const prices = await pricesRes.json();
    const cooloss = coolossRes.ok ? await coolossRes.json() : { count: 0, price: 400 };

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
      <div class="cooloss-shard-shop">
        <div class="cooloss-shard-shop-icon"><img src="cooloss-shard.png" alt=""></div>
        <div class="cooloss-shard-shop-info">
          <div class="cooloss-shard-shop-title hf-cond">SHARD COOLOSS</div>
          <div class="hf-mono" style="font-size:11px;color:rgba(16,22,28,.5)">
            Joker : permet de déverrouiller une shard sur n'importe quelle carte. En stock : <span id="cooloss-shard-shop-owned">${cooloss.count}</span>
          </div>
        </div>
        <div class="cooloss-shard-shop-buy">
          <div class="hf-mono" id="cooloss-shard-shop-price" style="font-size:15px;font-weight:500;color:var(--ink)">${Math.ceil(cooloss.price)} <span style="font-size:11px;color:rgba(16,22,28,.4)">DOLLOSS</span></div>
          <button class="booster-option-buy hf-cond" id="cooloss-shard-buy-btn">ACHETER</button>
        </div>
      </div>
    `;
    // [data-type] exclut le bouton d'achat de la shard cooloss, qui partage
    // la même classe pour le style mais n'a pas de type de booster — sans
    // ce filtre, il déclenchait AUSSI buyAndRevealBooster(undefined), qui
    // achetait silencieusement un booster common (booster_type omis du JSON
    // -> défaut serveur "common") au lieu d'acheter le joker.
    body.querySelectorAll('.booster-option-buy[data-type]').forEach((btn) => {
      btn.addEventListener('click', () => buyAndRevealBooster(btn.dataset.type));
    });
    document.getElementById('cooloss-shard-buy-btn').addEventListener('click', buyCoolossShard);

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

async function buyCoolossShard() {
  const btn = document.getElementById('cooloss-shard-buy-btn');
  if (!btn) return;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch('/api/cooloss-shard/buy', { method: 'POST' });
    if (r.status === 402) {
      btn.textContent = 'INSUFFISANT';
      setTimeout(() => { btn.textContent = prevText; btn.disabled = false; }, 1200);
      return;
    }
    if (!r.ok) throw new Error('buy failed');
    const data = await r.json();

    animateDollossCounter(document.getElementById('dolloss-value'), data.dolloss);
    const countPill = document.getElementById('cooloss-shard-count');
    if (countPill) countPill.textContent = data.cooloss_shards;
    if (currentCollection) {
      currentCollection.dolloss = data.dolloss;
      currentCollection.cooloss_shards = data.cooloss_shards;
    }

    const owned = document.getElementById('cooloss-shard-shop-owned');
    if (owned) owned.textContent = data.cooloss_shards;
    const priceEl = document.getElementById('cooloss-shard-shop-price');
    if (priceEl) priceEl.innerHTML = `${Math.ceil(data.next_price)} <span style="font-size:11px;color:rgba(16,22,28,.4)">DOLLOSS</span>`;

    btn.textContent = '✓ ACHETÉ';
    setTimeout(() => { btn.textContent = prevText; btn.disabled = false; }, 900);

    // Un nouveau bouton "utiliser une shard cooloss" peut désormais
    // apparaître sur les cartes verrouillées de la grille.
    renderGrid();
  } catch (_) {
    btn.textContent = prevText;
    btn.disabled = false;
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
    animateDollossCounter(document.getElementById('dolloss-value'), data.dolloss);
    if (currentCollection) currentCollection.dolloss = data.dolloss;

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

// Silhouette fixe pour le joker (shard cooloss) : pas de media_id associé,
// donc pas de géométrie calculée côté serveur — on garde quand même
// l'esthétique "éclat de verre" plutôt qu'un rectangle générique.
const COOLOSS_SHARD_CLIP = 'polygon(50% 0%, 90% 20%, 100% 60%, 65% 100%, 15% 90%, 0% 35%)';

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

// Ordre d'affichage du reveal spotlight : le tirage le plus rare arrive
// TOUJOURS en dernier (suspense construit par l'ordre, pas par le hasard du
// tirage réel) — demande explicite du redesign "spotlight séquentiel".
const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3, cooloss: 4 };

// Temps où l'éclat reste "sur la tranche" (invisible, voir .flipping en CSS)
// avant que le contenu révélé soit posé dessous — plus long pour les tiers
// rares, ça laisse le suspense monter avant l'impact.
const REVEAL_HOLD_MS = { common: 200, rare: 260, epic: 340, legendary: 520, cooloss: 260 };

// Carillon de révélation synthétisé (Web Audio, pas de fichier son à
// charger) — un arpège de plus en plus riche/aigu selon la rareté, calé sur
// le volume général partagé (voir getSharedVolume) pour ne jamais surprendre
// quelqu'un qui a mis le son bas.
let revealAudioCtx = null;
const REVEAL_CHIME_FREQS = {
  common: [523.25],
  rare: [523.25, 659.25],
  epic: [523.25, 659.25, 783.99],
  legendary: [523.25, 659.25, 783.99, 1046.5],
  cooloss: [659.25, 987.77],
};
function playRevealChime(tier) {
  const vol = getSharedVolume();
  if (vol <= 0) return;
  try {
    if (!revealAudioCtx) revealAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = revealAudioCtx;
    const freqs = REVEAL_CHIME_FREQS[tier] || REVEAL_CHIME_FREQS.common;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.07;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(vol * 0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  } catch (_) { /* Web Audio indisponible/bloqué — jamais bloquant pour la révélation */ }
}

// Flash radial + gerbe de particules colorées par tier, posés en overlay
// DANS .shard-visual (pas .spotlight-stage, bien plus large que l'éclat
// lui-même) — un inset négatif calculé contre la largeur pleine du stage
// créait un débordement horizontal du modal-body pendant les ~550ms de vie
// du flash (scrollbar qui apparaît puis disparaît, très inélégant).
// Nettoyés d'eux-mêmes après leur transition (pas de nœuds qui traînent
// entre deux ouvertures).
function spawnRevealImpact(visual, tier) {
  const color = `var(--tier-${tier}-bracket)`;
  const flash = document.createElement('div');
  flash.className = 'spotlight-flash';
  flash.style.setProperty('--flash-color', color);
  visual.appendChild(flash);
  requestAnimationFrame(() => flash.classList.add('pulse'));
  setTimeout(() => flash.remove(), 550);

  const particleCount = tier === 'legendary' ? 20 : tier === 'epic' ? 14 : tier === 'cooloss' ? 16 : 9;
  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('div');
    p.className = 'spotlight-particle';
    p.style.setProperty('--particle-color', color);
    const angle = (Math.PI * 2 * i) / particleCount + Math.random() * 0.4;
    const dist = 70 + Math.random() * 90;
    p.style.setProperty('--px', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--py', `${Math.sin(angle) * dist}px`);
    visual.appendChild(p);
    requestAnimationFrame(() => p.classList.add('burst'));
    setTimeout(() => p.remove(), 750);
  }
}

// Nuage de particules ambiantes qui dérivent en boucle autour de l'éclat
// (remplace l'ancien halo flouté qui épousait son contour) — posées dans
// .shard-visual, en dehors de la zone clippée par le polygone, donc
// visibles TOUT AUTOUR de la silhouette plutôt que dessus.
function renderAmbientParticles(visual, tier) {
  const color = `var(--tier-${tier}-bracket)`;
  const count = tier === 'legendary' ? 10 : (tier === 'epic' || tier === 'cooloss') ? 8 : 6;
  const ambient = document.createElement('div');
  ambient.className = 'shard-ambient';
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'shard-ambient-dot';
    dot.style.setProperty('--particle-color', color);
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const radius = 90 + Math.random() * 50;
    dot.style.setProperty('--px', `${Math.cos(angle) * radius}px`);
    dot.style.setProperty('--py', `${Math.sin(angle) * radius}px`);
    dot.style.setProperty('--dur', `${1.8 + Math.random() * 1.4}s`);
    dot.style.setProperty('--delay', `${Math.random() * 2}s`);
    ambient.appendChild(dot);
  }
  visual.appendChild(ambient);
}

function renderShardBacks(results) {
  // Tri par rareté croissante : le meilleur tirage du lot est toujours
  // révélé en dernier, quel que soit l'ordre réel renvoyé par le serveur.
  const ordered = [...results].sort((a, b) => (RARITY_ORDER[a.tier] ?? 0) - (RARITY_ORDER[b.tier] ?? 0));

  document.getElementById('booster-modal-card').className = 'modal-card modal-card--wide modal-card--spotlight';
  const subtitle = document.getElementById('booster-modal-subtitle');
  const body = document.getElementById('booster-modal-body');
  document.getElementById('booster-modal-ok').textContent = 'TERMINER';

  body.innerHTML = `
    <div class="spotlight-stage" id="spotlight-stage"></div>
    <div class="spotlight-dots" id="spotlight-dots">
      ${ordered.map((_, i) => `<span class="spotlight-dot hf-mono" id="spotlight-dot-${i}">?</span>`).join('')}
    </div>
  `;
  if (subtitle) subtitle.textContent = `1 / ${ordered.length} — CLIQUE POUR RÉVÉLER`;

  renderSpotlightSlot(ordered, 0);
}

function renderSpotlightSlot(ordered, index) {
  const subtitle = document.getElementById('booster-modal-subtitle');
  if (index >= ordered.length) {
    if (subtitle) subtitle.textContent = 'PACK OUVERT';
    return;
  }
  const res = ordered[index];
  const stage = document.getElementById('spotlight-stage');
  if (subtitle) subtitle.textContent = `${index + 1} / ${ordered.length} — CLIQUE POUR RÉVÉLER`;

  for (let i = 0; i < index; i++) {
    const doneDot = document.getElementById(`spotlight-dot-${i}`);
    if (doneDot) doneDot.classList.remove('active');
  }
  const dot = document.getElementById(`spotlight-dot-${index}`);
  if (dot) dot.classList.add('active');

  let clipStyle = '';
  if (res.tier === 'cooloss') {
    clipStyle = ` style="clip-path:${COOLOSS_SHARD_CLIP}"`;
  } else if (res.newly_revealed_points) {
    clipStyle = ` style="clip-path:${normalizedClipPath(res.newly_revealed_points, pieceBBox(res.newly_revealed_points))}"`;
  }

  stage.innerHTML = `
    <div class="shard-back spotlight-active${res.tier === 'legendary' ? ' legendary' : ''}" id="shard-back-active">
      <div class="shard-visual">
        <div class="shard-back-inner hf-mono"${clipStyle}>?</div>
      </div>
    </div>
  `;
  renderAmbientParticles(document.querySelector('#shard-back-active .shard-visual'), res.tier);
  document.getElementById('shard-back-active').addEventListener(
    'click',
    () => revealShard(ordered, index),
    { once: true }
  );
}

async function revealShard(ordered, index) {
  const res = ordered[index];
  const slot = document.getElementById('shard-back-active');
  const dot = document.getElementById(`spotlight-dot-${index}`);
  slot.classList.add('revealing', 'flipping');

  // L'éclat est "sur la tranche" (invisible, transform CSS) pendant
  // REVEAL_HOLD_MS — le contenu réel est posé dessous à cet instant précis
  // pour que l'échange soit invisible, puis la carte se déplie dessus.
  await new Promise((resolve) => setTimeout(resolve, REVEAL_HOLD_MS[res.tier] ?? 240));

  if (res.tier === 'cooloss') {
    slot.classList.remove('revealing', 'flipping');
    slot.classList.add('revealed', 'assembled');
    const visual = slot.querySelector('.shard-visual');
    visual.innerHTML = '';
    const mediaWrap = document.createElement('div');
    mediaWrap.className = 'shard-back-media cooloss-shard-reveal';
    mediaWrap.innerHTML = '<img src="cooloss-shard.png" alt="">';
    visual.appendChild(mediaWrap);
    renderAmbientParticles(visual, 'cooloss');

    const info = document.createElement('div');
    info.className = 'shard-back-info';
    info.innerHTML = `
      <span class="tier-badge cooloss hf-cond">[Shard Cooloss]</span>
      <span class="hf-mono shard-info-sub">+1 en stock</span>
    `;
    slot.appendChild(info);

    spawnRevealImpact(visual, 'cooloss');
    playRevealChime('cooloss');
    if (dot) { dot.classList.remove('active'); dot.classList.add('done'); dot.textContent = ''; dot.style.setProperty('--dot-glow', 'var(--tier-cooloss-bracket)'); }

    const countPill = document.getElementById('cooloss-shard-count');
    if (countPill) countPill.textContent = res.cooloss_shards;
    if (currentCollection) currentCollection.cooloss_shards = res.cooloss_shards;

    const isLast = index === ordered.length - 1;
    // Un raté réseau ici (rechargement de la collection) ne doit jamais
    // bloquer la suite de la séquence — sinon un blip transitoire fige le
    // reveal en plein milieu, sans possibilité d'avancer.
    if (isLast) { try { await loadCollection(); } catch (_) {} }
    setTimeout(() => renderSpotlightSlot(ordered, index + 1), 1400);
    return;
  }

  const meta = await fetchMediaMeta(res.media_id);
  const videoUrl = meta ? `${MEMOSS_ORIGIN}${meta.url}` : '';
  const bbox = res.newly_revealed_points ? pieceBBox(res.newly_revealed_points) : null;

  slot.classList.remove('revealing', 'flipping');
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

  // On ne vide QUE .shard-visual (dos mystère → média révélé) : les
  // particules ambiantes sont recréées dans ce même conteneur, pas
  // conservées de l'état mystère (couleur différente possible si le tier
  // affiché avant/après clic venait à différer — jamais le cas ici, mais
  // plus simple à raisonner que de les faire survivre au clear).
  const visual = slot.querySelector('.shard-visual');
  visual.innerHTML = '';
  visual.appendChild(mediaWrap);
  renderAmbientParticles(visual, res.tier);

  const info = document.createElement('div');
  info.className = 'shard-back-info';
  info.innerHTML = `
    <span class="tier-badge ${res.tier} hf-cond">${TIER_LABELS[res.tier] || res.tier}</span>
    <span class="hf-mono shard-info-sub">${res.overflow_to_dolloss ? `+${res.overflow_to_dolloss} Dolloss (doublon)` : `+${res.shard_applied} shard`}</span>
  `;
  slot.appendChild(info);

  spawnRevealImpact(visual, res.tier);
  playRevealChime(res.tier);
  if (dot) { dot.classList.remove('active'); dot.classList.add('done'); dot.textContent = ''; dot.style.setProperty('--dot-glow', `var(--tier-${res.tier}-bracket)`); }

  const isLast = index === ordered.length - 1;
  // Un raté réseau ici ne doit jamais bloquer la suite de la séquence — voir
  // le même garde-fou dans la branche cooloss ci-dessus.
  if (isLast) { try { await loadCollection(); } catch (_) {} }

  // Après 2s, la carte complète apparaît et l'éclat "rentre" dedans : vidéo
  // non recadrée + vrai puzzle de la carte, à la place du gros plan
  // recadré sur ce seul éclat. Puis, après un temps d'admiration, on
  // enchaîne sur le tirage suivant (ou on s'arrête si c'était le dernier).
  setTimeout(() => {
    assembleCard(slot, res, videoUrl);
    setTimeout(() => renderSpotlightSlot(ordered, index + 1), 900);
  }, 2000);
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
    <span class="pps hf-mono">${res.points_per_sec.toFixed(1)} DOLLOSS/S</span>
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

// Spectre de couleur du toast de gain — paramétré en admin (ToastColorSettings,
// voir admin_router.py), transmis via currentCollection.toast_color_stops
// (déjà trié par seuil croissant côté serveur). Repli statique si la
// collection n'est pas encore chargée (ne devrait pas arriver en pratique,
// vu que le premier toast ne peut survenir qu'après un unlock).
const DEFAULT_TOAST_COLOR_STOPS = [
  { threshold: 0, color: '#c9d3da' },
  { threshold: 15, color: '#ffd75e' },
  { threshold: 40, color: '#ff9f43' },
  { threshold: 100, color: '#ff4d8f' },
];
function colorForGain(gain) {
  const stops = (currentCollection && currentCollection.toast_color_stops) || DEFAULT_TOAST_COLOR_STOPS;
  let color = stops[0].color;
  for (const stop of stops) {
    if (gain >= stop.threshold) color = stop.color;
  }
  return color;
}

// Toast partagé au-dessus du crédit Dolloss de l'economy bar — un seul
// nœud persistant (pas dans activePopCounters : contrairement aux toasts
// par carte, il ne doit PAS être détruit à chaque re-render de la grille,
// seulement recréé une fois pour toute la session).
let dollossToast = null;
function ensureDollossToast() {
  if (!dollossToast) {
    dollossToast = document.createElement('div');
    dollossToast.className = 'pop-counter';
    document.body.appendChild(dollossToast);
  }
  return dollossToast;
}

// Positionne/anime un toast "+N" au-dessus de anchorRect, coloré selon le
// spectre de gain — factorisé car appelé deux fois par boucle de carte
// débloquée : une fois sur la carte elle-même, une fois au-dessus du
// crédit Dolloss global (voir setupLoopPop).
function showGainToast(counter, anchorRect, gain) {
  counter.style.left = `${anchorRect.left + anchorRect.width / 2}px`;
  counter.style.top = `${anchorRect.top}px`;
  counter.style.color = colorForGain(gain);
  // Timeouts d'un cycle précédent nettoyés au cas où deux boucles très
  // courtes se chevauchent — sinon un ancien setTimeout peut retirer
  // les classes en plein milieu de la nouvelle animation.
  if (counter._popTimeout1) clearTimeout(counter._popTimeout1);
  if (counter._popTimeout2) clearTimeout(counter._popTimeout2);
  counter.textContent = `+${gain}`;
  counter.classList.remove('leaving');
  counter.classList.add('show');
  counter._popTimeout1 = setTimeout(() => {
    counter.classList.add('leaving'); // s'élève en s'estompant
    counter._popTimeout2 = setTimeout(() => counter.classList.remove('show', 'leaving'), 500);
  }, 700);
}

// Anime le crédit Dolloss affiché en défilant vers sa nouvelle valeur (façon
// odomètre de machine à sous) plutôt que de sauter instantanément dessus —
// _dollossDisplay suit la valeur RÉELLEMENT affichée à l'écran (pas la
// cible) pour qu'un nouvel appel pendant une animation en cours reparte de
// là où l'œil en est, au lieu de sauter ou de faire clignoter le chiffre.
function animateDollossCounter(el, to) {
  if (!el) return;
  to = Math.floor(to);
  const from = typeof el._dollossDisplay === 'number'
    ? el._dollossDisplay
    : parseInt((el.textContent || '0').replace(/[^\d-]/g, ''), 10) || 0;
  if (el._dollossAnimId) cancelAnimationFrame(el._dollossAnimId);
  if (from === to) {
    el.textContent = to.toLocaleString('fr-FR');
    el._dollossDisplay = to;
    return;
  }

  // tickIntervalMs cadence chaque incrément dans le temps réel (et pas juste
  // à chaque frame ~16ms, sinon même un pas de 1 défile en un flou illisible
  // pour un petit gain) ; maxDurationMs borne la durée totale pour les gros
  // montants — au-delà, le pas grandit pour ne pas compter pendant 10s.
  const tickIntervalMs = 40;
  const maxDurationMs = 2000;
  const maxTicks = Math.max(1, Math.round(maxDurationMs / tickIntervalMs));
  const step = Math.max(1, Math.round(Math.abs(to - from) / maxTicks));
  const dir = to > from ? 1 : -1;
  let current = from;
  let lastTick = performance.now();

  el.classList.add('counting');
  const frame = (now) => {
    if (now - lastTick >= tickIntervalMs) {
      lastTick = now;
      current += dir * step;
      const done = (dir > 0 && current >= to) || (dir < 0 && current <= to);
      const shown = done ? to : current;
      el.textContent = shown.toLocaleString('fr-FR');
      el._dollossDisplay = shown;
      if (done) {
        el._dollossAnimId = null;
        el.classList.remove('counting');
        return;
      }
    }
    el._dollossAnimId = requestAnimationFrame(frame);
  };
  el._dollossAnimId = requestAnimationFrame(frame);
}

function setupLoopPop(video, mediaEl, counter, pointsPerSec) {
  // Pas d'attribut `loop` natif : avec `loop`, l'event `ended` ne se
  // déclenche jamais côté navigateur. On boucle manuellement pour pouvoir
  // accrocher le "pop" de gain à chaque fin de boucle réelle (whitepaper §5.1).
  video.addEventListener('ended', () => {
    const duration = video.duration || 0;
    const gain = Math.round(duration * pointsPerSec);
    if (counter) {
      // .meme-card a overflow:hidden (nécessaire pour les coins arrondis de
      // la vidéo) — un toast positionné au-dessus de la carte y serait
      // rogné s'il restait descendant de cet élément. counter vit donc en
      // dehors, "téléporté" (position:fixed) au-dessus de mediaEl à chaque
      // déclenchement via son rect live, pas rattaché au flux de la carte.
      showGainToast(counter, mediaEl.getBoundingClientRect(), gain);
    }
    const dollossValueEl = document.getElementById('dolloss-value');
    if (dollossValueEl) {
      showGainToast(ensureDollossToast(), dollossValueEl.getBoundingClientRect(), gain);
      // Le solde exact reste calculé côté serveur à la volée (pas de
      // persistance par tick, voir collection_router.py) — ce +gain local
      // ne fait qu'anticiper visuellement ce que le prochain fetch
      // confirmera, pour que le compteur bouge à chaque boucle plutôt que
      // de rester figé entre deux rechargements.
      const newTotal = (typeof dollossValueEl._dollossDisplay === 'number' ? dollossValueEl._dollossDisplay : 0) + gain;
      if (currentCollection) currentCollection.dolloss = newTotal;
      animateDollossCounter(dollossValueEl, newTotal);
    }
    video.currentTime = 0;
    video.play().catch(() => {
      // Le redémarrage après 'ended' est un play() sans geste utilisateur
      // direct — si la carte vient d'être survolée (donc démutée), le
      // navigateur peut le refuser purement et simplement, ce qui fige la
      // vidéo sur sa dernière frame indéfiniment. On retente en muet pour
      // ne jamais rester bloqué, quitte à perdre le son jusqu'au prochain
      // survol (hoverInMemeAudio le redémute de toute façon).
      video.muted = true;
      video.play().catch(() => {});
    });
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
  video._shouldPlay = true; // valeur par défaut avant le premier passage de videoObserver
  video.muted = true;
  video.volume = 0; // le fondu au survol part toujours de 0, jamais d'un pic à pleine puissance
  video.playsInline = true;
  video.preload = 'none';
  mediaEl.appendChild(video);
  videoObserver.observe(video);
  attachPauseRetry(video);
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
    // Sur document.body, pas dans mediaEl : .meme-card a overflow:hidden,
    // ça rognerait le toast qui doit s'élever au-dessus de la carte. Le
    // positionnement réel se fait via getBoundingClientRect() à chaque
    // déclenchement (voir setupLoopPop) — suivi manuel du nettoyage dans
    // activePopCounters, sinon ces nœuds fuient hors du cycle de vie
    // normal de la grille (grid.innerHTML = '' ne les toucherait pas).
    document.body.appendChild(popCounter);
    activePopCounters.add(popCounter);
  }

  el.appendChild(mediaEl);

  const band = document.createElement('div');
  band.className = 'meme-card-band';
  band.innerHTML = `
    <span class="pps hf-mono">${cardData.points_per_sec.toFixed(1)} DOLLOSS/S</span>
    <span class="tier-badge ${cardData.tier} hf-cond">${TIER_LABELS[cardData.tier] || cardData.tier}</span>
    <span class="mult hf-mono">×${cardData.quality_multiplier.toFixed(2)}</span>
  `;
  el.appendChild(band);

  if (cardData.unlocked) {
    // Rebouclage manuel (pas l'attribut natif) pour pouvoir accrocher le
    // "pop" de gain exactement à la fin de chaque boucle réelle.
    setupLoopPop(video, mediaEl, popCounter, cardData.points_per_sec);
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

  // Joker en stock : icône sur cette même ligne pour l'appliquer directement
  // sur CETTE carte — n'apparaît que sur les cartes verrouillées (inutile
  // une fois débloquée) et seulement si le joueur en possède au moins une.
  if (!cardData.unlocked && currentCollection && currentCollection.cooloss_shards > 0) {
    const useBtn = document.createElement('button');
    useBtn.className = 'cooloss-shard-use-icon';
    useBtn.innerHTML = '<img src="cooloss-shard.png" alt="">';
    useBtn.title = 'Utiliser une shard cooloss';
    useBtn.addEventListener('click', () => useCoolossShardOnCard(cardData.media_id, useBtn));
    shardCount.appendChild(useBtn);
  }

  el.appendChild(shardCount);

  return el;
}

async function renderGrid() {
  const grid = document.getElementById('card-grid');
  // Change de filtre = la grille précédente va être jetée : détache ses
  // vidéos de l'observer plutôt que de laisser des références à des
  // éléments hors DOM s'accumuler dedans.
  grid.querySelectorAll('video').forEach((v) => videoObserver.unobserve(v));
  // Les toasts "+N" vivent sur document.body (voir renderCard), pas comme
  // descendants de #card-grid — grid.innerHTML='' plus bas ne les
  // toucherait jamais, il faut les retirer explicitement.
  activePopCounters.forEach((el) => el.remove());
  activePopCounters.clear();

  const cardsRaw = activeFilter === 'all'
    ? currentCollection.cards
    : currentCollection.cards.filter((c) => c.tier === activeFilter);

  if (!cardsRaw.length) {
    grid.innerHTML = `<div class="empty-state">${
      currentCollection.cards.length ? 'Aucune carte dans ce tier.' : 'Joue une partie de Memoss pour commencer ta collection.'
    }</div>`;
    return;
  }

  // Terminées d'abord (toutes tiers confondus), en cours ensuite — et à
  // l'intérieur de CHACUNE des deux phases, regroupées par tier (du plus
  // rare au plus commun), avec à l'intérieur d'un tier la carte la plus
  // proche d'être complétée en premier (le moins de shards manquantes).
  // Array.sort est stable (ES2019) : à égalité, l'ordre d'obtention
  // d'origine sert de départage.
  function groupByTier(list) {
    return TIER_ORDER
      .map((tier) => list.filter((c) => c.tier === tier))
      .filter((group) => group.length > 0)
      .map((group) => {
        group.sort((a, b) => (a.shards_required - a.shards_owned) - (b.shards_required - b.shards_owned));
        return group;
      });
  }
  const completedGroups = groupByTier(cardsRaw.filter((c) => c.unlocked));
  const inProgressGroups = groupByTier(cardsRaw.filter((c) => !c.unlocked));
  const cards = [...completedGroups.flat(), ...inProgressGroups.flat()];

  // Chaque renderCard() fait plusieurs fetch async (meta média, fragments) —
  // les résoudre en parallèle mais les insérer dans l'ordre d'origine du
  // tableau, sinon l'ordre d'arrivée réseau détermine l'ordre à l'écran et
  // les cartes semblent se réarranger à chaque rechargement.
  const elements = await Promise.all(cards.map((cardData) => renderCard(cardData)));
  grid.innerHTML = '';
  let cardIndex = 0;

  function renderPhase(groups, phaseLabel) {
    if (!groups.length) return;
    // Pas de label pour la phase "terminées" : sous-entendu (en tête de
    // grille), l'ajouter alourdissait pour rien. "En cours" reste affiché,
    // plus utile pour repérer où commence la partie pas encore complète.
    if (phaseLabel) {
      const phaseSep = document.createElement('div');
      phaseSep.className = 'grid-section-break grid-section-break--phase hf-mono';
      phaseSep.textContent = phaseLabel;
      grid.appendChild(phaseSep);
    }
    groups.forEach((group) => {
      const tierSep = document.createElement('div');
      tierSep.className = 'grid-section-break hf-mono';
      tierSep.textContent = (TIER_LABELS[group[0].tier] || group[0].tier).toUpperCase();
      grid.appendChild(tierSep);
      for (let i = 0; i < group.length; i++) {
        grid.appendChild(elements[cardIndex]);
        cardIndex++;
      }
    });
  }

  renderPhase(completedGroups, null);
  renderPhase(inProgressGroups, 'EN COURS');
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

async function useCoolossShardOnCard(mediaId, btn) {
  // Ressource limitée (achetée ou lootée) — un mauvais clic ne doit pas la
  // dépenser sans confirmation.
  if (!confirm('Utiliser une shard cooloss sur cette carte ?')) return;

  const prevHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/cooloss-shard/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId }),
    });
    if (r.status === 400) {
      // Stock vide (une autre carte a consommé la dernière entre-temps,
      // par ex. dans un autre onglet) — recharge pour faire disparaître
      // tous les boutons devenus invalides.
      await loadCollection();
      return;
    }
    if (!r.ok) throw new Error('apply failed');
    const data = await r.json();
    if (currentCollection) currentCollection.cooloss_shards = data.cooloss_shards;
    const countPill = document.getElementById('cooloss-shard-count');
    if (countPill) countPill.textContent = data.cooloss_shards;
    // Recharge la grille entière : shards_owned/unlocked à jour pour cette
    // carte, et les boutons "utiliser" des autres cartes disparaissent si
    // le stock vient de tomber à 0.
    await loadCollection();
  } catch (_) {
    if (btn) { btn.disabled = false; btn.innerHTML = prevHtml; }
  }
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
  const completedCount = currentCollection.cards.filter((c) => c.unlocked).length;
  document.getElementById('cards-completed').textContent = `${completedCount} CARTE${completedCount > 1 ? 'S' : ''} COMPLÈTE${completedCount > 1 ? 'S' : ''}`;
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
  document.getElementById('admin-modal-close').addEventListener('click', () => {
    document.getElementById('admin-modal').hidden = true;
  });
  document.getElementById('admin-modal-save').addEventListener('click', saveAdminConfig);

  // Le volume partagé dépend de AccountWidget.session (compte connecté ou
  // invité) — doit être chargé avant setupVolumeControl()/setupBackgroundMusic().
  await AccountWidget.load();
  AccountWidget.mount('account-widget');
  addAdminMenuItem();
  setupVolumeControl();
  setupBackgroundMusic();
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
