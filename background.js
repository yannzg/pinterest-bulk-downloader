/**
 * Pinterest Bulk Downloader — background.js (service worker)
 *
 * Receives a download job from the page, then for each pin, in order:
 *   1. resolves the best-quality URL (/originals/ via HEAD probes, else /736x/),
 *   2. optionally renders it to a 1080×1920 JPEG (9:16 crop or blur fit),
 *   3. downloads it as <folder>/<NN>.<ext> inside the Downloads folder,
 *   4. reports progress back to the tab.
 *
 * MV3 service workers can be killed when idle, so the job lives in
 * chrome.storage.session and is resumed when the worker starts again.
 */

// ---------- Fragile values ----------

// Pinterest size segment in image URLs: /236x/, /736x/, /75x75_RS/, …
const SIZE_SEGMENT_RE = /\/\d+x\d*(_RS)?\//;
// Extensions to probe for /originals/, in order.
const ORIGINAL_EXTENSIONS = ['jpg', 'png', 'webp', 'gif'];
// Size segment used when no original can be found.
const FALLBACK_SIZE_SEGMENT = '/736x/';
const ALLOWED_URL_PREFIX = 'https://i.pinimg.com/';

// ---------- Tunables ----------

const DELAY_BETWEEN_ITEMS_MS = 150;
const HEAD_TIMEOUT_MS = 8000;
const GET_TIMEOUT_MS = 20000;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const JPEG_QUALITY = 0.92;
const BLUR_RADIUS_PX = 40;
const BLUR_DARKEN_ALPHA = 0.2;
const MAX_LOGGED_FAILURES = 200;
const FORMATS = ['original', 'crop', 'blur'];

// chrome.storage.session keys. The URL list is stored once, separately from
// the small progress record that gets rewritten after every item.
const JOB_KEY = 'pbdJob';
const QUEUE_KEY = 'pbdQueue';
const STOP_KEY = 'pbdStop';

// True while this worker instance is running the download loop.
let loopActive = false;

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'download') {
    startJob(msg, sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the channel open for the async response
  }

  if (msg?.type === 'stop') {
    chrome.storage.session.set({ [STOP_KEY]: true }).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

/** Send a message to the page overlay; the tab may be gone, which is fine. */
function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ---------- Job lifecycle ----------

async function startJob(msg, tabId) {
  const urls = Array.isArray(msg.urls)
    ? msg.urls.filter((u) => typeof u === 'string' && u.startsWith(ALLOWED_URL_PREFIX))
    : [];
  if (urls.length === 0) return { ok: false, error: 'No images to download.' };

  const format = FORMATS.includes(msg.format) ? msg.format : 'original';

  const { [JOB_KEY]: existing } = await chrome.storage.session.get(JOB_KEY);
  if (existing) return { ok: false, error: 'Another download is still running.' };

  const job = {
    tabId,
    folder: sanitizePathPart(msg.folder) || 'board',
    format,
    pad: urls.length > 99 ? 4 : 2,
    total: urls.length,
    index: 0,
    saved: 0,
    failed: 0,
    failures: [],
  };

  await chrome.storage.session.set({ [JOB_KEY]: job, [QUEUE_KEY]: urls, [STOP_KEY]: false });
  runJob(); // deliberately not awaited: respond to the page right away
  return { ok: true, total: urls.length };
}

/** Process the stored queue one item at a time until done or stopped. */
async function runJob() {
  if (loopActive) return;
  loopActive = true;

  try {
    const stored = await chrome.storage.session.get([JOB_KEY, QUEUE_KEY]);
    const job = stored[JOB_KEY];
    const urls = stored[QUEUE_KEY];
    if (!job || !Array.isArray(urls)) return;

    while (true) {
      const { [STOP_KEY]: stopRequested } = await chrome.storage.session.get(STOP_KEY);
      if (stopRequested || job.index >= urls.length) {
        await finishJob(job, Boolean(stopRequested) && job.index < urls.length);
        return;
      }

      const result = await processItem(job, urls[job.index], job.index);
      if (result.ok) {
        job.saved++;
      } else {
        job.failed++;
        if (job.failures.length < MAX_LOGGED_FAILURES) {
          job.failures.push({ url: urls[job.index], reason: result.reason });
        }
      }
      job.index++;

      await chrome.storage.session.set({ [JOB_KEY]: job });
      notifyTab(job.tabId, {
        type: 'progress',
        done: job.index,
        total: job.total,
        saved: job.saved,
        failed: job.failed,
      });

      await sleep(DELAY_BETWEEN_ITEMS_MS);
    }
  } catch (err) {
    console.error('Pinterest Bulk Downloader: download loop crashed', err);
  } finally {
    loopActive = false;
  }
}

async function finishJob(job, stopped) {
  if (job.failures.length) {
    console.warn(`Pinterest Bulk Downloader: ${job.failed} item(s) failed`, job.failures);
  }
  await chrome.storage.session.remove([JOB_KEY, QUEUE_KEY, STOP_KEY]);
  notifyTab(job.tabId, {
    type: 'done',
    saved: job.saved,
    failed: job.failed,
    total: job.total,
    stopped,
  });
}

// ---------- One item ----------

/** Resolve, (optionally) render and download a single pin. Never throws. */
async function processItem(job, thumbUrl, index) {
  const number = String(index + 1).padStart(job.pad, '0');

  let resolved;
  try {
    resolved = await resolveBestUrl(thumbUrl);
  } catch (err) {
    return logFailure(thumbUrl, `resolve: ${err?.message || err}`);
  }

  if (job.format !== 'original') {
    try {
      const dataUrl = await renderVertical(resolved, job.format);
      await download(dataUrl, `${job.folder}/${number}.jpg`);
      return { ok: true };
    } catch (err) {
      // Fall through to downloading the original file instead.
      console.warn(`Pinterest Bulk Downloader: ${job.format} processing failed, saving original instead`, resolved, err);
    }
  }

  try {
    await download(resolved, `${job.folder}/${number}.${extensionOf(resolved)}`);
    return { ok: true };
  } catch (err) {
    return logFailure(resolved, `download: ${err?.message || err}`);
  }
}

function logFailure(url, reason) {
  console.warn('Pinterest Bulk Downloader: failed', url, reason);
  return { ok: false, reason };
}

function download(url, filename) {
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
}

// ---------- Best-quality URL resolution ----------

/**
 * Try /originals/<path>.<ext> for each known extension (HEAD), first hit wins.
 * Otherwise fall back to the 736px version with the thumbnail's extension.
 */
async function resolveBestUrl(thumbUrl) {
  const originalBase = thumbUrl
    .replace(SIZE_SEGMENT_RE, '/originals/')
    .replace(/\.[a-z0-9]+(\?.*)?$/i, '');

  for (const ext of ORIGINAL_EXTENSIONS) {
    const candidate = `${originalBase}.${ext}`;
    try {
      const res = await fetchWithTimeout(candidate, { method: 'HEAD' }, HEAD_TIMEOUT_MS);
      if (res.ok) return candidate;
    } catch {
      // Network error or timeout: try the next extension.
    }
  }

  return thumbUrl.replace(SIZE_SEGMENT_RE, FALLBACK_SIZE_SEGMENT);
}

function extensionOf(url) {
  const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : 'jpg';
  return ext === 'jpeg' ? 'jpg' : ext;
}

// ---------- 9:16 rendering ----------

/**
 * Render the image onto a 1080×1920 canvas and return a JPEG data URL.
 * (URL.createObjectURL isn't available in service workers.)
 * Animated GIFs: createImageBitmap only decodes the first frame, which is what we want.
 */
async function renderVertical(url, format) {
  const res = await fetchWithTimeout(url, {}, GET_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());

  try {
    const canvas = new OffscreenCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

    if (format === 'crop') {
      drawCover(ctx, bitmap, 0);
    } else {
      drawBlurredBackground(ctx, bitmap);
      ctx.fillStyle = `rgba(0, 0, 0, ${BLUR_DARKEN_ALPHA})`;
      ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      drawContain(ctx, bitmap);
    }

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

/** Scale to cover the canvas (plus an optional bleed on each side), centered. */
function drawCover(ctx, img, bleed) {
  const w = OUTPUT_WIDTH + bleed * 2;
  const h = OUTPUT_HEIGHT + bleed * 2;
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (OUTPUT_WIDTH - dw) / 2, (OUTPUT_HEIGHT - dh) / 2, dw, dh);
}

/** Scale to fit entirely inside the canvas, centered. */
function drawContain(ctx, img) {
  const scale = Math.min(OUTPUT_WIDTH / img.width, OUTPUT_HEIGHT / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (OUTPUT_WIDTH - dw) / 2, (OUTPUT_HEIGHT - dh) / 2, dw, dh);
}

function drawBlurredBackground(ctx, img) {
  if ('filter' in ctx) {
    // Draw slightly oversized so the blur doesn't fade to transparent at the edges.
    ctx.filter = `blur(${BLUR_RADIUS_PX}px)`;
    drawCover(ctx, img, BLUR_RADIUS_PX * 2);
    ctx.filter = 'none';
    return;
  }

  // Fallback without canvas filters: shrink a lot, then scale back up smoothly.
  const small = new OffscreenCanvas(Math.round(OUTPUT_WIDTH / 20), Math.round(OUTPUT_HEIGHT / 20));
  const sctx = small.getContext('2d');
  const scale = Math.max(small.width / img.width, small.height / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  sctx.drawImage(img, (small.width - dw) / 2, (small.height - dh) / 2, dw, dh);
  ctx.drawImage(small, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // stay well below the argument-count limit of fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// ---------- Utilities ----------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Make a string safe as a single folder name on Windows/macOS/Linux. */
function sanitizePathPart(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 150);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Resume after a worker restart ----------

// If the worker was killed mid-job, the queue is still in session storage:
// pick up where we left off (the interrupted item is simply redone).
runJob();
