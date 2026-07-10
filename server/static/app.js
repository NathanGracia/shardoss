'use strict';

const MEMOSS_ORIGIN = 'https://memoss.nathangracia.com';
const TIER_LABELS = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

let mediaMetaCache = new Map();
let currentCollection = null;
let activeFilter = 'all';
const tierCursorKey = 'shardoss_tier_cursor';

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
            <div class="booster-option-icon hf-mono">PACK</div>
            <div class="booster-option-label tier-badge ${type} hf-cond">${info.label}</div>
            <div class="hf-mono" style="font-size:11px;color:rgba(16,22,28,.5)">${info.shards} shards</div>
            <div class="hf-mono" style="font-size:15px;font-weight:500;color:var(--ink)">${Math.ceil(info.price)} <span style="font-size:10px;color:rgba(16,22,28,.4)">DOLLOSS</span></div>
            <button class="booster-option-buy hf-cond" data-type="${type}">ACHETER</button>
          </div>
        `).join('')}
      </div>
    `;
    body.querySelectorAll('.booster-option-buy').forEach((btn) => {
      btn.addEventListener('click', () => buyAndRevealBooster(btn.dataset.type));
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

function renderShardBacks(results) {
  const body = document.getElementById('booster-modal-body');
  const okBtn = document.getElementById('booster-modal-ok');
  okBtn.textContent = 'TERMINER';

  body.innerHTML = `<div class="shard-reveal-row">
    ${results.map((res, i) => `
      <div class="shard-back" id="shard-back-${i}" style="--glow: var(--tier-${res.tier}-bracket)">
        <div class="shard-back-inner hf-mono">?</div>
      </div>
    `).join('')}
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
  slot.innerHTML = `<div class="hf-mono" style="font-size:10px;color:rgba(16,22,28,.4)">…</div>`;

  let fragmentsHtml = '';
  try {
    const r = await fetch(`/api/collection/${res.media_id}/fragments`);
    if (r.ok) fragmentsHtml = buildShatterSvg(await r.json());
  } catch (_) { /* pas bloquant, on affiche quand même la carte sans le puzzle */ }

  slot.classList.remove('revealing');
  slot.classList.add('revealed');
  slot.innerHTML = `
    <div class="shard-back-media">${fragmentsHtml}</div>
    <div class="shard-back-info">
      <span class="tier-badge ${res.tier} hf-cond">${TIER_LABELS[res.tier] || res.tier}</span>
      <span class="hf-mono" style="font-size:11px;color:rgba(16,22,28,.5)">${res.overflow_to_dolloss ? `+${res.overflow_to_dolloss} Dolloss (doublon)` : `+${res.shard_applied} shard`}</span>
    </div>
  `;

  const allRevealed = document.querySelectorAll('.shard-back:not(.revealed)').length === 0;
  if (allRevealed) await loadCollection();
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
  video.src = videoUrl;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  mediaEl.appendChild(video);

  const popCounter = document.createElement('div');
  popCounter.className = 'pop-counter';
  popCounter.textContent = '+0';
  mediaEl.appendChild(popCounter);

  el.appendChild(mediaEl);

  const band = document.createElement('div');
  band.className = 'meme-card-band';
  band.innerHTML = `
    <span class="pps hf-mono">${cardData.points_per_sec.toFixed(1)} PTS/S</span>
    <span class="tier-badge ${cardData.tier} hf-cond">${TIER_LABELS[cardData.tier] || cardData.tier}</span>
    <span class="mult hf-mono">×${cardData.quality_multiplier.toFixed(2)}</span>
  `;
  el.appendChild(band);

  setupLoopPop(video, mediaEl, cardData.points_per_sec);

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
})();
