# Pinterest Bulk Downloader

A personal Chrome extension for downloading Pinterest board images in the best
available quality: pick pins in the order you want (or grab the whole board) and
save them as originals or as phone-ready 9:16 slides for TikTok photo posts.

No dependencies, no build step, no servers: just vanilla JavaScript.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin Pinterest Bulk Downloader to the toolbar.
5. Recommended: in Chrome settings → Downloads, turn off
   **Ask where to save each file before downloading**, or Chrome will prompt for every image.

## Use

Open a Pinterest **board** (`pinterest.com/<user>/<board>/`) or a **search results page**
(`pinterest.com/search/pins/?q=…`), on any regional domain (`.com`, `.fr`, `.de`, `.co.uk`, …),
and click the Pinterest Bulk Downloader icon.

### Select pins (main mode)
- A round badge appears on each pin. Click the badge or the pin image to select it.
  Pinterest's own buttons (Save, share, …) keep working.
- Selected pins show their order number (1, 2, 3…). Deselecting renumbers the rest.
  Selections survive scrolling away and back.
- The bar at the bottom shows the count, with **Select all**, **Clear**, **Exit** and **Download**.
  It warns (without blocking) above 35 pins, TikTok's photo post limit.

### Download whole board
The popup's **Up to N images** field (default 100, max 5,000, remembered) caps how many
pins are collected, on boards and search results alike. Set it high to grab a whole big board.

Pinterest Bulk Downloader scrolls the board from the top, collecting every pin, and stops when no new
pins show up for a few rounds. Press **Stop** at any time to use what was found so far.

Before anything downloads, every pin is shown ticked and numbered in board order
("52 of 52 selected"). Scroll through and untick any bad images; re-ticking puts a pin
back in its board position. **Select all** re-ticks everything, then **Download**.

In select mode, **Select all** ticks every pin currently loaded on the page.

### Download search results
On a search page the second button reads **Download search results**. It works like
whole-board mode, skipping ads ("Sponsored"), then shows the same review step. Files go to `PinterestBulkDownloader/Search - <query> - <date>/`.

### Formats
Chosen in the **Save as** panel right before downloading (your last choice is remembered),
with a live preview of the first image:

| Format | Result |
|---|---|
| **Original** | The image as-is, best available quality (`/originals/`, else 736px). |
| **9:16 crop** | 1080×1920 JPG filling the screen; edges trimmed. |
| **9:16 blur fit** | 1080×1920 JPG: the whole image centered on a blurred, slightly darkened copy of itself. |

Files are saved in order as `01.jpg`, `02.png`, … (4 digits past 99 images) to
`Downloads/PinterestBulkDownloader/<user> - <board> - <YYYY-MM-DD HHmm>/`.
Progress shows at the top right, with a **Stop** button.

## Known limitations

- **Videos**: video pins are saved as their cover image only.
- **Recommendations**: pins below a "More ideas" / "More like this" heading are skipped,
  detected by heading text (English plus a few other languages). If Pinterest
  shows recommendations without such a heading, some may slip into whole-board downloads.
- **Pinterest markup changes**: selectors and URL patterns are constants at the top of
  `collector.js` and `background.js`. If Pinterest Bulk Downloader stops finding pins, update them first.
- Very large originals are processed one at a time; 9:16 formats are slower than Original.
- Only one download job runs at a time.
- Ads are detected by their "Sponsored" label (English plus a few other languages).
  An ad with a label in another language may slip through; untick it in the review step.

## Files

| File | Role |
|---|---|
| `popup.*` | Toolbar popup: checks the tab and injects the collector in the chosen mode. |
| `collector.js` / `overlay.css` | In-page UI: badges, bar, auto-scroll, format panel, progress. |
| `background.js` | Service worker: best-quality URLs, 9:16 rendering, sequential downloads, resume after restart. |

## Note

Pinterest Bulk Downloader is for personal use. The images belong to their creators. Respect their rights
and Pinterest's terms when reposting.
