# AirSign

[![Latest release](https://img.shields.io/github/v/release/abhinavtie2008/AirSign?label=release)](https://github.com/abhinavtie2008/AirSign/releases/latest)
[![Live demo](https://img.shields.io/badge/demo-live-brightgreen)](https://abhinavtie2008.github.io/AirSign/)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](#requirements)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Touchless browsing for Chrome. Point, pinch, drag, and scroll with your hand.

**[Try the live demo](https://abhinavtie2008.github.io/AirSign/)** · **[Download v2.3.1](https://github.com/abhinavtie2008/AirSign/releases/latest)**

**Jump to:** [Install](#install) · [Gestures](#gestures) · [Camera bubble](#camera-bubble) · [Tuning](#tuning) · [Test page](#the-test-page) · [Privacy](#privacy) · [Troubleshooting](#troubleshooting) · [Development](#development)



Touchless browsing for Chrome. AirSign turns hand movements into real webpage interactions using a webcam, while MediaPipe hand tracking runs locally inside Chrome — in the side panel, or in an extension offscreen document when you shrink AirSign to a camera bubble.

**Point** to move the cursor, **pinch** to click, close a **fist** to drag, and raise **two fingers** to scroll. No mouse, no touch, no server.

Try it in the browser before installing: **https://abhinavtie2008.github.io/AirSign/** runs the same gesture engine, page bridge and local model as the extension, right in the tab. The showcase source lives in [`docs/`](docs/).

Pinch detection can be fitted to your own hand with a two-step calibration, so a relaxed hand clicks reliably across different cameras, lighting and seating distances. Click assist previews the button or link under your fingertip and keeps the click there, so small aiming errors do not land on the wrong control.

This is an experimental hackathon project, not a sign-language translator. It understands four deliberate hand shapes and nothing else.

## Requirements

- Google Chrome 116 or newer (or another Chromium browser with side-panel support)
- A webcam
- A desktop or laptop with a reasonably steady camera position

## Install

1. Download `AirSign-v2.3.1.zip` from [the latest release](https://github.com/abhinavtie2008/AirSign/releases/latest) and unzip it. Keep the folder together — the `vendor/` directory contains the local MediaPipe runtime.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin AirSign to the toolbar (puzzle icon → pin).
6. Open any `http://` or `https://` page and click the AirSign toolbar icon. The side panel opens.
7. Click **Start AirSign** and allow camera access.
8. To save screen space, click **Minimize to camera bubble**; the panel closes and a draggable camera bubble stays over the page. Use **Panel** in the bubble to bring the side panel back.

On first use, Chrome may not show the camera prompt inside the side panel. AirSign detects that and opens a one-time setup tab. Allow access there; the tab closes and tracking starts in the panel. After that, Start AirSign works directly in the panel.

The test page is optional but recommended: click **Open test page** in the panel to practise every gesture without touching a real website.

## Gestures

| Gesture | Action | How to do it |
| --- | --- | --- |
| ☝️ Point | Move the cursor | Extend only your index finger, with the rest of the hand relaxed or curled. |
| 🤏 Pinch | Click | Bring your thumb and index fingertip together. One pinch = one click, with a short cooldown so a held pinch cannot click twice. Click assist previews the nearby target before you pinch. |
| ✊ Fist | Grab and drag | Close your whole hand over something, move, then open your hand to release. |
| ✌️ Two fingers | Scroll | Extend your index and middle fingers, then move your hand up or down. Scroll distance is measured in hand widths, so it feels the same near or far from the camera. |

Hold a gesture for a couple of frames. AirSign debounces pose changes, so a single noisy frame will not trigger anything.

The side panel shows a live preview with hand landmarks, the current gesture, the active target tab, and the frame rate.

## Camera bubble

The side panel is helpful while you set things up, but it takes up screen space once you are just browsing. Click **Minimize to camera bubble** while AirSign is running to collapse it into a small camera bubble over the page.

- The side panel closes and the bubble appears in the tab AirSign is controlling. It shows the mirrored camera preview, the hand skeleton, the current gesture, and two buttons: **Panel** and **Stop**.
- Drag the bubble by its header to put it anywhere on the page; it stays inside the viewport and remembers its position for next time.
- Gestures keep working while minimized. Point, pinch, fist and two-finger scroll behave exactly as they do with the panel open.
- **Panel** reopens the side panel and resumes tracking there. **Stop** ends the session and removes the bubble and the page cursor.
- Bubble mode needs a regular `http://` or `https://` page, because the bubble is injected as a content script. Navigating to another regular page keeps the session going; opening a protected Chrome page or closing the tab stops it.
- Leaving the target tab pauses the camera and tracking until you come back. This is intentional: the camera does not run while you are looking at something else.

## The test page

`sandbox.html` is bundled with the extension. It includes:

- clickable counter buttons, toggles and likeable cards
- a fist-draggable slider and note card
- a genuinely scrollable inner panel
- a live HUD fed by the same frames the panel sends to real websites
- an event log showing the pointer events that actually reach the page

It receives frames through the extension's own runtime messaging rather than a content-script channel, so it also acts as an end-to-end check of the page bridge.

## Tuning

Open the **Tuning** section in the side panel:

- **Reach** — how much hand travel maps to the whole screen. Compact needs the smallest arm movement; Wide is the most precise but needs a bigger movement.
- **Smoothing** — higher values steady the cursor more; lower values feel snappier.
- **Mirror camera** — on by default, so moving your hand right moves the cursor right.
- **Click assist** — on by default. When your fingertip is within about 18 px of a button or link (and not already over one), AirSign outlines that target and adds a small “CLICK + name” tag. Pinching then clicks the previewed element, even if the fingertip is a few pixels off. The cursor itself does not jump, so you can still see exactly where your hand is.
- **Pinch calibration** — fit click detection to your own thumb and index finger. The defaults work for most hands; calibrate if pinches click too easily, feel unreliable, or if the panel regularly misreads a relaxed hand as a click.

### Click assist

Aiming a cursor in mid-air is imprecise, especially next to small or tightly packed controls. Click assist solves that without taking control away from you:

- The cursor stays under your finger at all times. Assist never moves it for you.
- If the fingertip is already over an interactive element, that exact element wins; no assist targeting is applied.
- If the fingertip is just outside one, the nearest eligible target within the acquire radius is outlined and named. The preview is sticky: it only switches to a different control once that control is clearly closer, so resting between two buttons does not flicker.
- On pinch, the preview is frozen and that element receives the click. The click point is the visible center of the target when assisted, or the fingertip position on a direct hit.
- Turn **Click assist** off in Tuning to require exact hits.

The radius is deliberately small (18 px to acquire, 28 px to keep), and probe points only look at real interactive elements under and around the fingertip. Dense toolbars, icon buttons, and neighbouring +/− controls resolve to the nearest center.

### Calibrating your pinch

Click **Calibrate pinch** (in Tuning or from the message after starting). AirSign briefly pauses page control and asks for two poses:

1. **Open hand** — hold your hand open, palm toward the camera, for about a second and a half.
2. **Now pinch** — touch your thumb and index fingertips together and hold until the bar fills.

AirSign measures your own open and pinched thumb-to-index ratios and stores two thresholds: one to start a click and a slightly wider one to release it. The hysteresis means a hand hovering near the edge of a pinch will not flicker between pointing and clicking. The open hand must be measurably wider than the pinch; if not, the panel reports "Pinch not clear" without changing your previous settings. **Reset** returns to the defaults.

Settings are stored with `chrome.storage.local`.

## How it works

1. **Capture** — the side panel opens the webcam with `getUserMedia`. When you minimize, an extension offscreen document takes over the camera and closes the side panel, because closing the panel would otherwise destroy the video track.
2. **Detect** — `@mediapipe/tasks-vision` (bundled locally) runs `HandLandmarker` on a `<video>` at up to 30 fps and returns 21 landmarks. In bubble mode the offscreen document also draws a mirrored JPEG preview with the hand skeleton about every 120 ms.
3. **Interpret** — `lib/gestures.mjs` classifies the hand shape, maps the index fingertip through an active zone, smooths it with a One Euro filter, and handles debouncing, pinch hysteresis, click locking and suppressed clicks after a fist. Pinch thresholds are the defaults until calibration replaces them, and clicks have a 320 ms cooldown. Scroll distance is divided by hand width, so moving your hand the same physical distance scrolls the same amount near or far from the lens. `lib/one-euro.mjs` is the filter itself.
4. **Send** — with the panel open, the panel sends a normalized frame (`pose`, `x`, `y`, palm coordinates, scroll anchor, hand width) directly to the target page with `chrome.tabs.sendMessage`. In bubble mode, the offscreen tracker sends frames and previews to the service worker, which forwards frames to the target tab and previews to the bubble. The sandbox receives the same frames via a runtime broadcast.
5. **Act** — `content.js` interpolates the cursor, draws a shadow-DOM overlay, previews the nearest eligible click target, and dispatches genuine pointer, mouse and click events. Fist drag is palm-anchored and relative; two-finger scroll finds the scrollable element under the cursor and falls back to the page.

The service worker configures the side panel and, in bubble mode, acts as a router: it starts and stops the offscreen tracker, forwards frames and previews, and restores the panel on request. Gesture interpretation still runs entirely in the extension, and the router never sends previews anywhere except the bubble in the target tab.

### Project layout

```
manifest.json          Chrome MV3 manifest
background.js          Side-panel setup, bubble routing, offscreen lifecycle
sidepanel.html/.css/.js  Panel UI, camera, MediaPipe, target switching
offscreen.html/.js     Hidden camera + MediaPipe tracker used in bubble mode
bubble.js              Draggable in-page camera bubble
content.js             Cursor overlay and synthetic input for web pages
lib/gestures.mjs       Pure gesture + cursor engine (unit tested)
lib/one-euro.mjs       One Euro smoothing filter (unit tested)
permission.html/.js    One-time camera permission tab
sandbox.html/.js       Built-in gesture test page
vendor/                Local MediaPipe HandLandmarker model and WASM runtime
tests/                 Node unit tests and synthetic landmark fixtures
icons/                 Extension icons
```

## Privacy

- Camera frames are processed in the side panel or, while minimized, in an extension offscreen document. They never leave the browser and are never written to disk.
- No analytics, no remote scripts, no network requests for hand tracking.
- The model, WASM runtime and vision bundle are all inside `vendor/` and loaded from the extension origin (required by MV3's remote-code policy).
- Page frames contain only gesture and normalized cursor coordinates — never image data.
- The camera preview shown in the bubble is a transient JPEG held in page memory and drawn into a closed shadow DOM. It is sent only to the bubble in the tab AirSign is controlling.
- In bubble mode, leaving the target tab pauses the camera and tracking entirely.

The extension needs `tabs`, `scripting`, `storage`, `offscreen` and host access to normal web pages so it can find the target tab, keep tracking alive while minimized, inject the page bridge and bubble if needed, and send frames. It cannot and does not run on `chrome://` pages, the Chrome Web Store, other extensions' pages, or local `file://` pages.

## Tests

No dependencies are required for the logic tests:

```bash
npm test
```

or directly:

```bash
node --test tests/gestures.test.mjs tests/one-euro.test.mjs
```

The suite covers point/pinch/fist/scroll classification, debounce thresholds, pinch hysteresis, click suppression after a fist, click locking, click cooldown, calibration derivation and validation, calibrated thresholds, distance-normalised scrolling, mirror/reach mapping, clamping, palm movement, dropout resets, and the One Euro filter.

Syntax check all runtime files:

```bash
npm run check
```

The UI is exercised end-to-end in headless Chrome with a fake camera and synthetic hand landmarks (startup, calibration, click assist near-miss and exact hits, assist toggle, click, drag, scroll, permission page). Bubble mode is tested on both the sandbox and a normal web page: minimizing closes the real side panel, the offscreen tracker drives a page click, the bubble drags and persists its position, the bubble and tracking survive a page navigation, hiding the tab pauses the camera, and Panel restores the side panel and auto-starts tracking. A real-camera pass in your own room is still the best check for lighting, seating distance and camera angle.

## Troubleshooting

**The camera prompt never appears in the side panel**
Use the setup tab AirSign opens, or allow the camera in `chrome://settings/content/camera`. If the permission page also fails, check that no other app is holding the camera exclusively.

**"Chrome protects this page"**
Normal Chrome pages (`chrome://…`), the Web Store, PDFs and other extensions cannot be scripted. Switch to a regular website or the built-in test page.

**The panel says the page is not connected / has an old bridge**
Reload the page with Ctrl+R. After updating or reloading the extension, also reload any tab that was open before the update, because content scripts from the old version are gone.

**No cursor on the page**
Make sure tracking is running, the target tab is the one you are looking at, and your hand is visible in the preview. AirSign pauses when you switch to a protected Chrome page.

**The camera bubble does not appear after minimizing**
The bubble is a content script, so it only works on regular `http://` and `https://` pages. Chrome's protected pages, the Web Store, PDFs and `file://` pages cannot host it. If you installed or reloaded the extension while the tab was already open, reload the tab once.

**The camera pauses when I switch tabs in bubble mode**
This is intentional. AirSign pauses the camera and hand tracking while the target tab is hidden and resumes when you return. Click **Panel** if you would rather keep the side panel open across tabs.

**The bubble is partly off-screen after resizing the window**
AirSign clamps the bubble into the viewport whenever it appears, but a large resize can leave it at the edge. Drag it back by the header; the new position is remembered.

**Gestures feel inverted**
Turn **Mirror camera** off. If only vertical scrolling feels wrong, remember the scroll direction follows your hand relative to where the gesture started: raise your hand to scroll up, lower it to scroll down.

**The cursor is shaky**
Choose **Compact** reach, raise smoothing, and improve lighting. A hand at the edge of the frame or a very low camera shutter speed makes tracking noisier.

**A relaxed hand clicks by itself, or pinching does not click**
Run **Calibrate pinch** and hold a clearly open hand at step 1, then a firm pinch at step 2. If it says "Pinch not clear", check that the preview shows your whole hand and that the thumb and index tips visibly meet. You can reset to the defaults at any time.

**Air clicks land on the wrong control**
Keep **Click assist** on and watch the outline before pinching: only the outlined element will be clicked. If two controls are very close, slow down for a moment; the preview deliberately sticks to its current target until a neighbour is clearly closer. Turning assist off requires an exact hit.

**The model fails to load**
Reinstall the extension from its folder and reload it in `chrome://extensions`. The `vendor/` directory must contain `hand_landmarker.task`, `vision_bundle.mjs`, and the files under `vendor/wasm/`.

**Some websites ignore air clicks**
AirSign dispatches synthetic (untrusted) DOM events, because a web page cannot move the real OS mouse. Most buttons, links, toggles and JS-driven drags work, but native HTML5 drag-and-drop, some canvas apps, cross-origin iframes and security-sensitive controls may ignore them. Keyboard focus is moved to the clicked element so keyboard flows can still work.

## License

MIT. See [LICENSE](LICENSE).

MediaPipe is licensed separately; see `vendor/MEDIAPIPE-README.md` and the upstream project.
