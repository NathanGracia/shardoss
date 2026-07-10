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
  refreshBoosterPrice();
  document.getElementById('booster-buy-btn').addEventListener('click', openBoosterModal);
}

async function refreshBoosterPrice() {
  try {
    const r = await fetch('/api/boosters/price');
    if (!r.ok) return;
    const { price } = await r.json();
    const btn = document.getElementById('booster-buy-btn');
    if (btn) btn.textContent = `+ ACHETER UN BOOSTER — ${Math.ceil(price)}`;
  } catch (_) { /* silencieux, non-bloquant */ }
}

function openBoosterModal() {
  const modal = document.getElementById('booster-modal');
  const body = document.getElementById('booster-modal-body');
  const subtitle = document.getElementById('booster-modal-subtitle');
  const okBtn = document.getElementById('booster-modal-ok');
  subtitle.textContent = '5 shards, tiers indépendants — clique pour ouvrir';
  body.innerHTML = `<div style="text-align:center;padding:24px 0">
    <div class="hf-cond" style="font-size:15px;font-weight:600;letter-spacing:.04em;color:var(--ink);cursor:pointer;display:inline-block;padding:14px 28px;border-radius:12px;border:1px solid rgba(16,22,28,.15);background:rgba(255,255,255,.6)" id="booster-open-trigger">TAP TO OPEN</div>
  </div>`;
  okBtn.textContent = 'FERMER';
  modal.hidden = false;
  document.getElementById('booster-open-trigger').addEventListener('click', buyAndOpenBooster, { once: true });
}

async function buyAndOpenBooster() {
  const body = document.getElementById('booster-modal-body');
  const okBtn = document.getElementById('booster-modal-ok');
  body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.5)" class="hf-mono">Ouverture…</div>`;
  try {
    const r = await fetch('/api/boosters/buy', { method: 'POST' });
    if (r.status === 402) {
      body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Solde de Dolloss insuffisant.</div>`;
      return;
    }
    if (!r.ok) throw new Error('booster buy failed');
    const data = await r.json();
    document.getElementById('dolloss-value').textContent = Math.floor(data.dolloss).toLocaleString('fr-FR');

    body.innerHTML = data.results.map((res) => `
      <div class="booster-summary">
        <span style="font-family:'IBM Plex Sans',sans-serif;font-size:13px;color:var(--ink)">${res.media_id.slice(0, 10)}…</span>
        <span class="tier-badge ${res.tier}">${TIER_LABELS[res.tier] || res.tier}</span>
        <span class="hf-mono" style="font-size:12px;color:rgba(16,22,28,.5)">${res.overflow_to_dolloss ? `+${res.overflow_to_dolloss} Dolloss (doublon)` : `+${res.shard_applied} shard`}</span>
      </div>
    `).join('') || '<div class="empty-state">Aucune carte disponible — recalcul quotidien pas encore lancé.</div>';

    okBtn.textContent = 'TERMINER';
    await loadCollection();
    refreshBoosterPrice();
  } catch (_) {
    body.innerHTML = `<div style="text-align:center;padding:24px 0;color:rgba(16,22,28,.6)">Erreur pendant l'ouverture.</div>`;
  }
}

function buildShatterSvg(fragments) {
  const palette = ['#e7edf1', '#dbe4ea', '#eef3f6', '#d3dde3', '#e2e9ee'];
  const polys = fragments.pieces
    .map((p, i) => {
      const points = p.points.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' ');
      if (p.revealed) {
        return `<polygon points="${points}" fill="transparent" stroke="rgba(16,22,28,.15)" stroke-width="0.4"></polygon>`;
      }
      const fill = palette[i % palette.length];
      return `<polygon points="${points}" fill="${fill}" stroke="rgba(255,255,255,.7)" stroke-width="0.4"></polygon>`;
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
    video.style.display = 'none';
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

  if (meta && meta.url) {
    const dl = document.createElement('a');
    dl.href = videoUrl;
    dl.download = '';
    dl.textContent = 'Télécharger';
    dl.style.cssText = 'display:block;text-align:center;font-size:0.7rem;padding:6px;color:rgba(16,22,28,.4);font-family:\'IBM Plex Mono\',monospace;';
    el.appendChild(dl);
  }

  return el;
}

function renderGrid() {
  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';
  const cards = activeFilter === 'all'
    ? currentCollection.cards
    : currentCollection.cards.filter((c) => c.tier === activeFilter);

  if (!cards.length) {
    grid.innerHTML = `<div class="empty-state">${
      currentCollection.cards.length ? 'Aucune carte dans ce tier.' : 'Joue une partie de Memoss pour commencer ta collection.'
    }</div>`;
    return;
  }
  cards.forEach(async (cardData) => grid.appendChild(await renderCard(cardData)));
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
