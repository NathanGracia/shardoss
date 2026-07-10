'use strict';

const MEMOSS_ORIGIN = 'https://memoss.nathangracia.com';
const TIER_LABELS = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

let mediaMetaCache = new Map();
let tierCursorKey = 'shardoss_tier_cursor';

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
    <span class="dolloss" id="dolloss-value">${Math.floor(state.dolloss)} Dolloss</span>
    <span class="pps">${state.points_per_sec_total.toFixed(1)}/s</span>
    <button class="booster-buy" id="booster-buy-btn">Booster — …</button>
  `;
  refreshBoosterPrice();
  document.getElementById('booster-buy-btn').addEventListener('click', buyBooster);
}

async function refreshBoosterPrice() {
  try {
    const r = await fetch('/api/boosters/price');
    if (!r.ok) return;
    const { price } = await r.json();
    const btn = document.getElementById('booster-buy-btn');
    if (btn) btn.textContent = `Booster — ${Math.ceil(price)} Dolloss`;
  } catch (_) { /* silencieux, non-bloquant */ }
}

async function buyBooster() {
  const btn = document.getElementById('booster-buy-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/boosters/buy', { method: 'POST' });
    if (r.status === 402) {
      alert('Solde de Dolloss insuffisant.');
      return;
    }
    if (!r.ok) throw new Error('booster buy failed');
    const data = await r.json();
    document.getElementById('dolloss-value').textContent = `${Math.floor(data.dolloss)} Dolloss`;
    const summary = data.results
      .map((res) => `${TIER_LABELS[res.tier] || res.tier}${res.overflow_to_dolloss ? ' (doublon → Dolloss)' : ''}`)
      .join(', ');
    alert(`Booster ouvert : ${summary || 'aucune carte disponible'}`);
    await loadCollection();
  } finally {
    btn.disabled = false;
    refreshBoosterPrice();
  }
}

function buildShatterSvg(fragments) {
  const polys = fragments.pieces
    .map((p) => {
      const points = p.points.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' ');
      const cls = p.revealed ? 'revealed' : 'unrevealed';
      return `<polygon class="${cls}" points="${points}"></polygon>`;
    })
    .join('');
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${polys}</svg>`;
}

function setupLoopPop(video, card, pointsPerSec) {
  // Pas d'attribut `loop` natif : avec `loop`, l'event `ended` ne se
  // déclenche jamais côté navigateur. On boucle manuellement pour pouvoir
  // accrocher le "pop" de gain à chaque fin de boucle réelle (§5.1).
  video.addEventListener('ended', () => {
    const duration = video.duration || 0;
    const gain = Math.round(duration * pointsPerSec);
    const counter = card.querySelector('.pop-counter');
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
    <span class="pps-base">${cardData.points_per_sec.toFixed(1)}/s</span>
    <span class="tier-badge ${cardData.tier}">${TIER_LABELS[cardData.tier] || cardData.tier}</span>
    <span class="quality-mult">×${cardData.quality_multiplier.toFixed(2)}</span>
  `;
  el.appendChild(band);

  setupLoopPop(video, mediaEl, cardData.points_per_sec);

  if (!cardData.unlocked) {
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
    dl.style.cssText = 'display:block;text-align:center;font-size:0.7rem;padding:4px;color:#5a5266;';
    el.appendChild(dl);
  }

  return el;
}

async function loadCollection() {
  const r = await fetch('/api/collection');
  if (r.status === 401) {
    document.getElementById('card-grid').innerHTML =
      '<div class="empty-state">Connecte-toi pour voir ta collection.</div>';
    return;
  }
  const data = await r.json();
  renderEconomyBar(data);

  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';
  if (!data.cards.length) {
    grid.innerHTML = '<div class="empty-state">Joue une partie de Memoss pour commencer ta collection.</div>';
    return;
  }
  for (const cardData of data.cards) {
    grid.appendChild(await renderCard(cardData));
  }
}

async function pollTierNotifications() {
  const since = localStorage.getItem(tierCursorKey);
  const qs = since ? `?since_id=${encodeURIComponent(since)}` : '';
  try {
    const r = await fetch(`/api/tiers/notifications${qs}`);
    if (!r.ok) return;
    const data = await r.json();
    if (data.changes && data.changes.length) {
      const lines = data.changes.map(
        (c) => `${c.media_id.slice(0, 8)}… : ${c.old_tier || '?'} → ${c.new_tier} (${c.direction === 'up' ? '↑' : '↓'})`
      );
      console.info('Mouvements de tier:\n' + lines.join('\n'));
    }
    localStorage.setItem(tierCursorKey, String(data.latest_id));
  } catch (_) { /* silencieux */ }
}

(async function init() {
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
