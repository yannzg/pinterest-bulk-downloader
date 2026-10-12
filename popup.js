/**
 * Pinterest Bulk Downloader — popup.js
 *
 * Checks that the active tab is a Pinterest board or search results page,
 * then injects collector.js (plus overlay.css) in the chosen mode and closes
 * itself. All the real work happens in the page (collector.js) and the
 * service worker (background.js).
 */

// ---------- Tunables ----------

// First path segments that are Pinterest pages, not boards (/pin/123, /ideas/…, …).
const NON_BOARD_FIRST_SEGMENTS = ['pin', 'search', 'ideas', 'today', 'settings', 'business', 'news_hub'];

// Whole-page downloads stop after this many pins (search results never end,
// and big boards take a while). Editable in the popup and remembered.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5000;
const LIMIT_STORAGE_KEY = 'pbdLimit';

// ---------- Elements ----------

const selectBtn = document.getElementById('select-btn');
const boardBtn = document.getElementById('board-btn');
const limitInput = document.getElementById('limit-input');
const statusEl = document.getElementById('status');

let activeTabId = null;
let pageKind = null; // 'board' | 'search' | null

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

/**
 * 'board'  — pinterest.<tld>/<user>/<board>/ (any region: .com, .fr, .co.uk, …)
 * 'search' — pinterest.<tld>/search/pins/?q=…
 * null     — anything else.
 */
function classifyUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)pinterest\./.test(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments[0] === 'search' && segments[1] === 'pins' && url.searchParams.get('q')) return 'search';
  if (segments.length >= 2 && !NON_BOARD_FIRST_SEGMENTS.includes(segments[0])) return 'board';
  return null;
}

function readLimit() {
  const value = Math.round(Number(limitInput.value));
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/** Pass the mode and limit to the page, then inject the styles and the collector. */
async function launch(mode) {
  selectBtn.disabled = true;
  boardBtn.disabled = true;
  setStatus('Starting…');

  const limit = readLimit();
  chrome.storage.local.set({ [LIMIT_STORAGE_KEY]: limit });

  try {
    const target = { tabId: activeTabId };
    await chrome.scripting.executeScript({
      target,
      func: (chosenMode, chosenLimit) => {
        window.__pbdMode = chosenMode;
        window.__pbdLimit = chosenLimit;
      },
      args: [mode, limit],
    });
    await chrome.scripting.insertCSS({ target, files: ['overlay.css'] });
    await chrome.scripting.executeScript({ target, files: ['collector.js'] });
    window.close();
  } catch (err) {
    console.error('Pinterest Bulk Downloader: injection failed', err);
    setStatus('Could not start on this page. Try reloading the tab.', true);
    selectBtn.disabled = false;
    boardBtn.disabled = false;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageKind = tab?.url ? classifyUrl(tab.url) : null;
  if (!pageKind) {
    setStatus('Open a Pinterest board or search to use Pinterest Bulk Downloader.');
    return;
  }

  activeTabId = tab.id;

  if (pageKind === 'search') boardBtn.textContent = 'Download search results';

  const stored = await chrome.storage.local.get(LIMIT_STORAGE_KEY);
  limitInput.value = stored[LIMIT_STORAGE_KEY] || DEFAULT_LIMIT;
  limitInput.max = MAX_LIMIT;

  selectBtn.disabled = false;
  boardBtn.disabled = false;
  setStatus('Ready.');
}

selectBtn.addEventListener('click', () => launch('select'));
boardBtn.addEventListener('click', () => launch('board'));

init();
