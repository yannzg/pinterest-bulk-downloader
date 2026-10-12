/**
 * Pinterest Bulk Downloader — collector.js
 *
 * Injected into a Pinterest board page by the popup (window.__pbdMode is
 * set just before). Two modes:
 *   - "select": badges on every pin, click to pick pins in order, floating bar.
 *   - "board":  auto-scroll the whole board and collect every pin, then review
 *               them in select mode with everything ticked (untick bad ones).
 * Both end in the format panel ("Save as"), which hands the URLs to
 * background.js, then this script shows download progress until it's done.
 *
 * Everything lives in an IIFE so the file can be injected again without
 * "identifier already declared" errors.
 */
(() => {
  'use strict';

  // ---------- Fragile values: update these when Pinterest changes its markup ----------

  // Every Pinterest-hosted image on the page.
  const PIN_IMG_SELECTOR = 'img[src*="i.pinimg.com"], img[srcset*="i.pinimg.com"]';
  // Pin thumbnail sizes. Avatars (30x30_RS, 75x75_RS, …) don't match.
  const THUMB_SIZE_RE = /\/(170|236|474|564|736)x\//;
  // Any size segment, used to build a size-independent key for each pin.
  const ANY_SIZE_SEGMENT_RE = /\/(\d+x\d*(_RS)?|originals)\//;
  // One pin card in the masonry grid (nearest match is used).
  const GRID_ITEM_SELECTOR = '[data-test-id="pin"], [data-grid-item]';
  // Containers of the page's own pins (board or search results), tried in order;
  // falls back to document.
  const FEED_SELECTORS = [
    '[data-test-id="board-feed"]',
    '[data-test-id="base-board-pin-grid"]',
    '[data-test-id="search-feed"]',
  ];
  // Section cover tiles at the top of boards with sections.
  const SECTION_SELECTOR = '[data-test-id*="section" i]';
  // Heading of the recommendations block below the board ("More ideas", …).
  // Pins after this heading are ignored.
  const RECOMMENDATIONS_HEADING_SELECTOR = 'h1, h2, h3, [role="heading"]';
  const RECOMMENDATIONS_TEXT_RE =
    /^(more ideas|more like this|find more ideas|find some ideas|plus d['’]idées|trouvez des idées|weitere ideen|más ideas|altre idee|meer ideeën)/i;
  // Ads in the grid carry a visible "Sponsored" label (their test ids are
  // obfuscated and change), so they're detected by that text.
  const AD_LABEL_RE = /(sponsored|promoted|sponsorisé|gesponsert|patrocinado|sponsorizzato|gesponsord)/i;
  // The label element's own text starts with one of the words above.
  const AD_LABEL_EXACT_RE = new RegExp(`^${AD_LABEL_RE.source}(?![\\p{L}])`, 'iu');
  // Pinterest controls inside a pin card (Save, share, menus, outbound link).
  // Clicking these must never toggle selection.
  const PINTEREST_CONTROL_SELECTOR =
    'button, [role="button"], a[target="_blank"], input, select, textarea, [contenteditable="true"]';
  // A "control" covering at least this share of the image is treated as the
  // image itself (some hover overlays are one big clickable layer).
  const CONTROL_MAX_IMAGE_SHARE = 0.5;

  // ---------- Tunables ----------

  const SCROLL_STEP_FRACTION = 0.8;
  const SCROLL_WAIT_MS = 900;
  const STABLE_ROUNDS_TO_FINISH = 5;
  const DONE_MESSAGE_MS = 4000;
  const FADE_MS = 400;
  const FORMAT_STORAGE_KEY = 'pbdLastFormat';
  const PREVIEW_WIDTH = 135; // CSS px; 9:16 box
  const PREVIEW_HEIGHT = 240;
  const PREVIEW_BLUR_PX = 6; // ≈ 40px at 1080 wide, scaled to the preview
  const PREVIEW_DARKEN_ALPHA = 0.2;

  const FORMAT_OPTIONS = [
    { id: 'original', name: 'Original', desc: 'Image as-is, best quality' },
    { id: 'crop', name: '9:16 crop', desc: 'Fills the phone screen, edges trimmed' },
    { id: 'blur', name: '9:16 blur fit', desc: 'Whole image on a blurred background' },
  ];

  // ---------- Double-injection guard ----------

  if (window.__pbdRunning) {
    window.__pbd?.focus();
    return;
  }
  window.__pbdRunning = true;

  const mode = window.__pbdMode === 'board' ? 'board' : 'select';
  // Max pins to collect in whole-board/search mode (0 = no limit), from the popup.
  const collectLimit = Math.max(0, Number(window.__pbdLimit) || 0);
  const folderName = buildFolderName(); // fixed now, in case Pinterest navigates (SPA)

  // All mutable state for this run.
  const state = {
    selected: [], // normalized keys, in selection order
    thumbs: new Map(), // key -> thumbnail URL, for selected pins
    observer: null,
    decorateQueued: false,
    selectActive: false,
    stopCollecting: false,
    downloading: false,
    tornDown: false,
    // Review step of whole-board mode: all collected pins, in board order.
    reviewMode: false,
    boardOrder: [], // keys in grid order
    boardIndex: new Map(), // key -> position in boardOrder
    allThumbs: new Map(), // key -> thumbnail URL, for every collected pin
    ui: {}, // DOM nodes we created
  };

  window.__pbd = { focus: bringToFront };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  if (mode === 'select') startSelectMode();
  else runWholeBoard();

  // =====================================================================
  // Collecting pins (shared)
  // =====================================================================

  /** Pick the largest thumbnail-sized URL from an <img>'s src/srcset, or null. */
  function pickThumbUrl(img) {
    const candidates = [img.currentSrc, img.getAttribute('src')];
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      for (const part of srcset.split(',')) candidates.push(part.trim().split(/\s+/)[0]);
    }

    let best = null;
    let bestSize = 0;
    for (const url of candidates) {
      if (!url) continue;
      const match = url.match(THUMB_SIZE_RE);
      if (match && Number(match[1]) > bestSize) {
        best = url;
        bestSize = Number(match[1]);
      }
    }
    return best;
  }

  /** Size-independent key: "/ab/cd/ef/abcdef123" for any size/extension of a pin. */
  function pinKey(url) {
    return url
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(ANY_SIZE_SEGMENT_RE, '/')
      .replace(/\.[a-z0-9]+(\?.*)?$/i, '');
  }

  function getScopeRoot() {
    for (const selector of FEED_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return document;
  }

  /** The "More ideas" heading, if Pinterest renders one on this page. */
  function findRecommendationsHeading() {
    for (const heading of document.querySelectorAll(RECOMMENDATIONS_HEADING_SELECTOR)) {
      if (RECOMMENDATIONS_TEXT_RE.test(heading.textContent.trim())) return heading;
    }
    return null;
  }

  /**
   * All board pins currently in the DOM, in document (grid) order, deduped.
   * Returns [{ key, thumb, img, item }].
   */
  function collectVisiblePins() {
    const root = getScopeRoot();
    const hasGridItems = Boolean(root.querySelector(GRID_ITEM_SELECTOR));
    const cutoff = findRecommendationsHeading();
    const seenKeys = new Set();
    const seenItems = new Set();
    const pins = [];

    for (const img of root.querySelectorAll(PIN_IMG_SELECTOR)) {
      if (img.closest('.pbd-ui')) continue; // our own previews
      const thumb = pickThumbUrl(img);
      if (!thumb) continue;

      const item = img.closest(GRID_ITEM_SELECTOR);
      if (hasGridItems && !item) continue;
      if (img.closest(SECTION_SELECTOR)) continue;
      if (cutoff && cutoff.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING) continue;

      const host = item || img.parentElement;
      if (seenItems.has(host)) continue; // one image per pin card
      if (item && isAd(item)) continue;

      const key = pinKey(thumb);
      if (seenKeys.has(key)) continue;

      seenItems.add(host);
      seenKeys.add(key);
      pins.push({ key, thumb, img, item: host });
    }
    return pins;
  }

  /** True if a pin card shows a "Sponsored" label (cheap text check first). */
  function isAd(item) {
    if (!AD_LABEL_RE.test(item.textContent)) return false;
    for (const node of item.querySelectorAll('*')) {
      if (node.childElementCount === 0 && AD_LABEL_EXACT_RE.test(node.textContent.trim())) return true;
    }
    return false;
  }

  // =====================================================================
  // Select mode
  // =====================================================================

  function startSelectMode() {
    state.selectActive = true;
    document.documentElement.classList.add('pbd-select-active');

    buildSelectBar();
    decorate();

    state.observer = new MutationObserver(queueDecorate);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });

    // Capture phase on window runs before Pinterest's own handlers.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      window.addEventListener(type, onPinPointerEvent, true);
    }
  }

  function stopSelectMode() {
    if (!state.selectActive) return;
    state.selectActive = false;
    state.observer?.disconnect();
    state.observer = null;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      window.removeEventListener(type, onPinPointerEvent, true);
    }
    document.documentElement.classList.remove('pbd-select-active');
    document.querySelectorAll('.pbd-badge').forEach((el) => el.remove());
    document.querySelectorAll('.pbd-picked').forEach((el) => el.classList.remove('pbd-picked'));
    document.querySelectorAll('.pbd-host').forEach((el) => el.classList.remove('pbd-host'));
    state.ui.bar?.remove();
    state.ui.bar = null;
  }

  /** Re-decorate at most once per frame, however many mutations arrive. */
  function queueDecorate() {
    if (state.decorateQueued) return;
    state.decorateQueued = true;
    requestAnimationFrame(() => {
      state.decorateQueued = false;
      if (state.selectActive) decorate();
    });
  }

  /**
   * Make sure every visible pin has a badge reflecting its selection state.
   * Pinterest virtualizes the grid and may reuse card elements for other pins,
   * so the key is re-checked every time. Writes only when something changed,
   * otherwise our own edits would keep re-triggering the MutationObserver.
   */
  function decorate() {
    let boardGrew = false;
    for (const { key, thumb, img, item } of collectVisiblePins()) {
      if (item.dataset.pbdKey !== key) item.dataset.pbdKey = key;

      // Review mode: pins loaded after collection stopped (user scrolled further)
      // join the board unticked, so Select all and the "of M" count include them.
      if (state.reviewMode && !state.boardIndex.has(key)) {
        state.boardIndex.set(key, state.boardOrder.length);
        state.boardOrder.push(key);
        state.allThumbs.set(key, thumb);
        boardGrew = true;
      }

      let badge = item.querySelector(':scope > .pbd-badge');
      if (!badge) {
        if (getComputedStyle(item).position === 'static') item.classList.add('pbd-host');
        badge = document.createElement('div');
        badge.className = 'pbd-badge';
        badge.setAttribute('role', 'checkbox');
        badge.title = 'Select for Pinterest Bulk Downloader';
        item.appendChild(badge);
      }
      if (badge.dataset.key !== key) badge.dataset.key = key;

      const index = state.selected.indexOf(key);
      const isSelected = index >= 0;
      const label = isSelected ? String(index + 1) : '';
      if (badge.textContent !== label) badge.textContent = label;
      if (badge.classList.contains('is-selected') !== isSelected) {
        badge.classList.toggle('is-selected', isSelected);
        badge.setAttribute('aria-checked', String(isSelected));
      }
      if (img.classList.contains('pbd-picked') !== isSelected) {
        img.classList.toggle('pbd-picked', isSelected);
      }
    }
    if (boardGrew) updateSelectBar();
  }

  function toggleSelection(key, thumb) {
    const index = state.selected.indexOf(key);
    if (index >= 0) {
      state.selected.splice(index, 1);
      state.thumbs.delete(key);
    } else {
      state.selected.splice(insertPosition(key), 0, key);
      state.thumbs.set(key, thumb);
    }
    decorate();
    updateSelectBar();
  }

  /**
   * Where a newly ticked pin goes: at the end (click order) in select mode,
   * or back in its board position when reviewing a whole board.
   */
  function insertPosition(key) {
    if (!state.reviewMode || !state.boardIndex.has(key)) return state.selected.length;
    const position = state.boardIndex.get(key);
    const after = state.selected.findIndex((k) => (state.boardIndex.get(k) ?? Infinity) > position);
    return after === -1 ? state.selected.length : after;
  }

  /**
   * Review mode: tick every collected pin again (including ones loaded after
   * collection stopped), in board order.
   * Select mode: add the pins currently on the page that aren't ticked yet, in grid order.
   */
  function selectAll() {
    if (state.reviewMode) {
      state.selected = [...state.boardOrder];
      state.thumbs = new Map(state.allThumbs);
    } else {
      for (const { key, thumb } of collectVisiblePins()) {
        if (!state.thumbs.has(key)) {
          state.selected.push(key);
          state.thumbs.set(key, thumb);
        }
      }
    }
    if (state.selectActive) decorate();
    updateSelectBar();
  }

  function clearSelection() {
    state.selected = [];
    state.thumbs.clear();
    decorate();
    updateSelectBar();
  }

  /** Main pin image of a card and its key/thumbnail, or null. */
  function pinFromItem(item) {
    for (const img of item.querySelectorAll(PIN_IMG_SELECTOR)) {
      const thumb = pickThumbUrl(img);
      if (thumb) return { img, thumb, key: pinKey(thumb) };
    }
    return null;
  }

  function blockEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * Capture-phase handler: clicking a badge, or the image area of a pin,
   * toggles selection instead of opening the pin. Pinterest's own buttons
   * (Save, share, …) keep working.
   */
  function onPinPointerEvent(event) {
    if (!state.selectActive) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.pbd-ui')) return;

    const badge = target.closest('.pbd-badge');
    const item = (badge || target).closest(GRID_ITEM_SELECTOR) || badge?.parentElement;
    if (!item) return;

    const pin = pinFromItem(item);
    if (!pin) return;

    if (!badge) {
      const rect = pin.img.getBoundingClientRect();
      const insideImage =
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!insideImage) return;

      const control = target.closest(PINTEREST_CONTROL_SELECTOR);
      if (control && item.contains(control)) {
        const c = control.getBoundingClientRect();
        const share = (c.width * c.height) / Math.max(1, rect.width * rect.height);
        if (share < CONTROL_MAX_IMAGE_SHARE) return; // a real Pinterest button
      }
    }

    blockEvent(event);
    if (event.type === 'click') toggleSelection(pin.key, pin.thumb);
  }

  function buildSelectBar() {
    const bar = el('div', { className: 'pbd-ui pbd-bar' });
    const count = el('span', { className: 'pbd-bar-count' });
    const all = el('button', { className: 'pbd-btn pbd-btn-ghost', textContent: 'Select all' });
    const clear = el('button', { className: 'pbd-btn pbd-btn-ghost', textContent: 'Clear' });
    const exit = el('button', { className: 'pbd-btn pbd-btn-ghost', textContent: 'Exit' });
    const download = el('button', { className: 'pbd-btn pbd-btn-primary', textContent: 'Download' });

    all.addEventListener('click', selectAll);
    clear.addEventListener('click', clearSelection);
    exit.addEventListener('click', teardown);
    download.addEventListener('click', onSelectDownload);

    bar.append(count, sep(), all, sep(), clear, sep(), exit, download);
    document.body.appendChild(bar);
    state.ui.bar = bar;
    state.ui.barCount = count;
    state.ui.barDownload = download;
    updateSelectBar();

    function sep() {
      return el('span', { className: 'pbd-bar-sep', textContent: '·' });
    }
  }

  function updateSelectBar() {
    if (!state.ui.bar) return;
    const n = state.selected.length;
    state.ui.barCount.textContent = state.reviewMode
      ? `${n} of ${state.boardOrder.length} selected`
      : `${n} selected`;
    state.ui.barDownload.disabled = n === 0;
  }

  async function onSelectDownload() {
    if (state.selected.length === 0) return;
    const urls = state.selected.map((key) => state.thumbs.get(key));
    const format = await showFormatPanel(urls);
    if (!format) return; // cancelled: stay in select mode
    stopSelectMode();
    startDownload(urls, format);
  }

  // =====================================================================
  // Whole-board mode
  // =====================================================================

  async function runWholeBoard() {
    showStatus('Collecting pins… 0 found', {
      onStop: () => {
        state.stopCollecting = true;
        setStatus('Stopping…');
      },
    });

    // Start from the top: pins above the viewport may have been unloaded.
    window.scrollTo(0, 0);
    await sleep(SCROLL_WAIT_MS);

    const pins = new Map(); // key -> thumb, insertion order = grid order
    let lastCount = -1;
    let stableRounds = 0;

    const limitReached = () => collectLimit > 0 && pins.size >= collectLimit;

    while (!state.stopCollecting && !limitReached() && stableRounds < STABLE_ROUNDS_TO_FINISH) {
      for (const pin of collectVisiblePins()) {
        if (limitReached()) break;
        if (!pins.has(pin.key)) pins.set(pin.key, pin.thumb);
      }
      setStatus(collectLimit
        ? `Collecting pins… ${pins.size} / ${collectLimit}`
        : `Collecting pins… ${pins.size} found`);
      if (limitReached()) break;

      if (pins.size === lastCount) stableRounds++;
      else stableRounds = 0;
      lastCount = pins.size;

      window.scrollBy(0, window.innerHeight * SCROLL_STEP_FRACTION);
      await sleep(SCROLL_WAIT_MS);
    }

    if (state.tornDown) return; // user exited meanwhile

    if (pins.size === 0) {
      setStatus('No pins found on this page.', { hideStop: true });
      finishLater();
      return;
    }

    enterReview(pins);
  }

  /**
   * After collecting the whole board, switch to select mode with every pin
   * ticked in board order, so bad images can be unticked before downloading.
   */
  function enterReview(pins) {
    state.ui.status?.remove();
    state.ui.status = null;

    state.reviewMode = true;
    state.boardOrder = [...pins.keys()];
    state.boardIndex = new Map(state.boardOrder.map((key, i) => [key, i]));
    state.allThumbs = pins;
    selectAll();

    window.scrollTo(0, 0);
    startSelectMode();
  }

  // =====================================================================
  // Format panel
  // =====================================================================

  /** Resolve with 'original' | 'crop' | 'blur', or null if cancelled. */
  async function showFormatPanel(urls) {
    const lastFormat = await readLastFormat();

    return new Promise((resolve) => {
      const backdrop = el('div', { className: 'pbd-ui pbd-backdrop' });
      const panel = el('div', { className: 'pbd-panel', role: 'dialog' });
      panel.setAttribute('aria-label', 'Save as');

      const title = el('h2', { className: 'pbd-panel-title', textContent: 'Save as' });
      const subtitle = el('p', {
        className: 'pbd-panel-subtitle',
        textContent: `${urls.length} image${urls.length === 1 ? '' : 's'}`,
      });

      const options = el('div', { className: 'pbd-options' });
      let chosen = FORMAT_OPTIONS.some((o) => o.id === lastFormat) ? lastFormat : 'original';

      for (const opt of FORMAT_OPTIONS) {
        const label = el('label', { className: 'pbd-option' });
        const radio = el('input', { type: 'radio', name: 'pbd-format', value: opt.id });
        radio.checked = opt.id === chosen;
        radio.addEventListener('change', () => {
          chosen = opt.id;
          drawPreview();
        });
        const sketch = el('span', { className: 'pbd-sketch' });
        sketch.innerHTML = SKETCHES[opt.id]; // static markup defined below
        const text = el('span', { className: 'pbd-option-text' });
        text.append(
          el('strong', { textContent: opt.name }),
          el('span', { textContent: opt.desc }),
        );
        label.append(radio, sketch, text);
        options.appendChild(label);
      }

      const canvas = el('canvas', { className: 'pbd-preview' });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(PREVIEW_WIDTH * dpr);
      canvas.height = Math.round(PREVIEW_HEIGHT * dpr);
      canvas.style.width = `${PREVIEW_WIDTH}px`;
      canvas.style.height = `${PREVIEW_HEIGHT}px`;

      const body = el('div', { className: 'pbd-panel-body' });
      body.append(options, canvas);

      const cancel = el('button', { className: 'pbd-btn pbd-btn-ghost', textContent: 'Cancel' });
      const confirm = el('button', { className: 'pbd-btn pbd-btn-primary', textContent: 'Download' });
      const actions = el('div', { className: 'pbd-panel-actions' });
      actions.append(cancel, confirm);

      panel.append(title, subtitle, body, actions);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      state.ui.panel = backdrop;
      confirm.focus();

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        state.ui.panel = null;
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        }
      };
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => close(null));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      confirm.addEventListener('click', () => {
        saveLastFormat(chosen);
        close(chosen);
      });

      // Live preview of the first image, drawn from its thumbnail.
      const previewImg = new Image();
      previewImg.onload = drawPreview;
      previewImg.src = urls[0];

      function drawPreview() {
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        ctx.save();
        ctx.filter = 'none';
        ctx.fillStyle = chosen === 'original' ? '#f1f1f1' : '#000';
        ctx.fillRect(0, 0, W, H);
        if (previewImg.complete && previewImg.naturalWidth) {
          if (chosen === 'crop') {
            drawScaled(ctx, previewImg, W, H, 'cover', 0);
          } else if (chosen === 'blur') {
            const blur = PREVIEW_BLUR_PX * dpr;
            ctx.filter = `blur(${blur}px)`;
            drawScaled(ctx, previewImg, W, H, 'cover', blur * 2);
            ctx.filter = 'none';
            ctx.fillStyle = `rgba(0, 0, 0, ${PREVIEW_DARKEN_ALPHA})`;
            ctx.fillRect(0, 0, W, H);
            drawScaled(ctx, previewImg, W, H, 'contain', 0);
          } else {
            drawScaled(ctx, previewImg, W, H, 'contain', 0);
          }
        }
        ctx.restore();
      }
      drawPreview();
    });
  }

  function drawScaled(ctx, img, W, H, fit, bleed) {
    const w = W + bleed * 2;
    const h = H + bleed * 2;
    const scale = fit === 'cover'
      ? Math.max(w / img.naturalWidth, h / img.naturalHeight)
      : Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  async function readLastFormat() {
    try {
      const stored = await chrome.storage.local.get(FORMAT_STORAGE_KEY);
      return stored[FORMAT_STORAGE_KEY];
    } catch {
      return null;
    }
  }

  function saveLastFormat(format) {
    chrome.storage.local.set({ [FORMAT_STORAGE_KEY]: format }).catch(() => {});
  }

  // Tiny 9:16 "phone" sketches for the three options (static, trusted markup).
  const SKETCHES = {
    original: `
      <svg viewBox="0 0 36 44" width="36" height="44" aria-hidden="true">
        <rect x="3" y="10" width="30" height="24" rx="3" fill="#cfd8e3"/>
        <path d="M3 30l9-9 7 7 5-4 9 8v2H3z" fill="#7d93ad"/>
        <circle cx="25" cy="17" r="3" fill="#fff"/>
      </svg>`,
    crop: `
      <svg viewBox="0 0 36 44" width="36" height="44" aria-hidden="true">
        <rect x="0.5" y="10" width="35" height="24" rx="3" fill="none" stroke="#b5b5b5" stroke-dasharray="2 2"/>
        <rect x="10" y="2" width="16" height="40" rx="3" fill="#cfd8e3"/>
        <path d="M10 34l5-6 5 5 6-5v11a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3z" fill="#7d93ad"/>
        <rect x="10" y="2" width="16" height="40" rx="3" fill="none" stroke="#111" stroke-width="1.5"/>
      </svg>`,
    blur: `
      <svg viewBox="0 0 36 44" width="36" height="44" aria-hidden="true">
        <rect x="10" y="2" width="16" height="40" rx="3" fill="#a9b6c6"/>
        <rect x="10" y="16" width="16" height="12" fill="#cfd8e3"/>
        <path d="M10 28l5-5 4 3 3-2 4 4z" fill="#7d93ad"/>
        <rect x="10" y="2" width="16" height="40" rx="3" fill="none" stroke="#111" stroke-width="1.5"/>
      </svg>`,
  };

  // =====================================================================
  // Downloading & progress
  // =====================================================================

  async function startDownload(urls, format) {
    state.downloading = true;
    showStatus(`Starting download of ${urls.length}…`, { onStop: requestStop });

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'download', urls, folder: folderName, format });
    } catch (err) {
      response = { ok: false, error: 'Pinterest Bulk Downloader was reloaded. Refresh the page and try again.' };
    }

    if (!response?.ok) {
      state.downloading = false;
      setStatus(response?.error || 'Download could not start.', { hideStop: true });
      finishLater();
      return;
    }
    setStatus(`Downloading 0 / ${urls.length}`);
  }

  function requestStop() {
    setStatus('Stopping after the current image…', { hideStop: true });
    chrome.runtime.sendMessage({ type: 'stop' }).catch(() => {});
  }

  /** Progress and completion messages from background.js. */
  function onRuntimeMessage(msg) {
    if (!state.downloading) return;

    if (msg?.type === 'progress') {
      const failed = msg.failed ? ` · ${msg.failed} failed` : '';
      setStatus(`Downloading ${msg.done} / ${msg.total}${failed}`, { progress: msg.done / msg.total });
    } else if (msg?.type === 'done') {
      state.downloading = false;
      const noun = msg.saved === 1 ? 'image' : 'images';
      const failed = msg.failed ? ` (${msg.failed} failed)` : '';
      const text = msg.stopped
        ? `Stopped. ${msg.saved} ${noun} saved${failed}`
        : `Done! ${msg.saved} ${noun} saved${failed}`;
      setStatus(text, { hideStop: true, progress: 1 });
      finishLater();
    }
  }

  // =====================================================================
  // Status overlay (top-right)
  // =====================================================================

  function showStatus(text, { onStop } = {}) {
    state.ui.status?.remove();
    const box = el('div', { className: 'pbd-ui pbd-status' });
    const label = el('span', { className: 'pbd-status-text', textContent: text });
    const stop = el('button', { className: 'pbd-btn pbd-btn-stop', textContent: 'Stop' });
    const track = el('div', { className: 'pbd-progress' });
    const fill = el('div', { className: 'pbd-progress-fill' });
    track.appendChild(fill);
    track.hidden = true;

    if (onStop) stop.addEventListener('click', onStop);
    else stop.hidden = true;

    const row = el('div', { className: 'pbd-status-row' });
    row.append(label, stop);
    box.append(row, track);
    document.body.appendChild(box);
    state.ui.status = box;
    state.ui.statusText = label;
    state.ui.statusStop = stop;
    state.ui.statusFill = fill;
    state.ui.statusTrack = track;
  }

  function setStatus(text, { hideStop = false, progress } = {}) {
    if (!state.ui.status) return;
    state.ui.statusText.textContent = text;
    if (hideStop) state.ui.statusStop.hidden = true;
    if (typeof progress === 'number') {
      state.ui.statusTrack.hidden = false;
      state.ui.statusFill.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
    }
  }

  /** Show the final message for a moment, fade out, then clean everything up. */
  function finishLater() {
    setTimeout(() => {
      state.ui.status?.classList.add('is-fading');
      setTimeout(teardown, FADE_MS);
    }, DONE_MESSAGE_MS);
  }

  /** Called when the toolbar button is clicked again while we're running. */
  function bringToFront() {
    const target = state.ui.panel || state.ui.bar || state.ui.status;
    if (!target) return;
    target.classList.remove('pbd-flash');
    void target.offsetWidth; // restart the animation
    target.classList.add('pbd-flash');
  }

  // =====================================================================
  // Teardown
  // =====================================================================

  /** Remove all injected UI, observers and listeners, and reset the guard. */
  function teardown() {
    if (state.tornDown) return;
    state.tornDown = true;
    state.stopCollecting = true;
    stopSelectMode();
    state.ui.panel?.remove();
    state.ui.status?.remove();
    state.ui = {};
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // Extension context gone (extension reloaded): nothing to remove.
    }
    window.__pbdRunning = false;
    window.__pbd = null;
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  /**
   * "<board> - YYYY-MM-DD HHmmss" for boards, or
   * "<query> - YYYY-MM-DD HHmmss" for search results; safe as a folder name.
   * The timestamp keeps separate runs on the same board/search apart.
   */
  function buildFolderName() {
    const query = new URLSearchParams(location.search).get('q');
    // Board URLs are /<user>/<board>/[section/]: use the last segment.
    const name = query && location.pathname.startsWith('/search/')
      ? query
      : safeDecode(location.pathname.split('/').filter(Boolean).pop() || '');
    const board = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'board';

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `${board} - ${stamp}`;
  }

  function safeDecode(segment) {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  function el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
