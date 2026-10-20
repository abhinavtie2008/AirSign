<div align="center">
  <img src="icons/icon128.png" alt="AirSign logo" width="96" />
  <h1>AirSign</h1>
  <p><strong>Browse the web without touching anything.</strong></p>
  <p>Control supported webpages with hand gestures using your webcam — no mouse or touchscreen required.</p>
  <p>
    <a href="https://github.com/abhinavtie2008/AirSign"><img src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  </p>
</div>

---

## Overview

AirSign is an experimental Chrome extension that turns hand movements into webpage controls. It uses **MediaPipe Hands** to track your hand in real time, then sends gesture information to the webpage you are browsing.

The camera preview and hand tracking run directly in the **Chrome side panel**. Camera frames are processed locally in the browser; the extension does not upload webcam video to a server.

> AirSign uses a small set of predefined control gestures. It is not a sign-language translator.

## Features

- **Touchless cursor:** Move the virtual cursor by pointing with your index finger.
- **Pinch to click:** Bring your thumb and index fingertip together to click.
- **Fist to drag:** Close your hand into a fist to grab and drag supported page elements.
- **Two-finger scroll:** Raise your index and middle fingers and move your hand vertically to scroll.
- **Live side-panel preview:** See your webcam feed and detected hand landmarks while browsing.
- **Local processing:** Hand tracking runs on your device using local MediaPipe runtime assets.

## Gestures

| Gesture | Action | How to perform it |
| --- | --- | --- |
| ☝️ Point | Move cursor | Extend your index finger. |
| 🤏 Pinch | Click | Bring your thumb and index fingertip together. |
| ✊ Fist | Grab and drag | Close your hand into a fist over an element, move, then open your hand to release. |
| ✌️ Two fingers | Scroll | Extend your index and middle fingers, then move your hand up or down. |

Gesture reliability can vary with lighting, camera placement, hand visibility, and the website being controlled.

## Requirements

- Google Chrome **116 or later**.
- A working webcam.
- Node.js LTS and an internet connection for the one-time MediaPipe asset setup.

## Installation

AirSign is currently installed from source using Chrome's **Load unpacked** developer workflow.

### 1. Get the source code

Clone the repository:

```bash
git clone https://github.com/abhinavtie2008/AirSign.git
cd AirSign
```

Alternatively, download the repository as a ZIP from GitHub and extract it.

### 2. Prepare the MediaPipe files

On Windows, double-click `setup.bat` from the repository folder. It installs the pinned MediaPipe Hands dependency and prepares the local files in `vendor/`.

On macOS or Linux, run the equivalent commands from the repository folder:

```bash
npm install --no-audit --no-fund
npm run prepare-extension
```

This setup step requires an internet connection. Once the files are prepared, AirSign uses the local runtime assets when it runs.

### 3. Load AirSign in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository folder — the one containing `manifest.json`.
5. Open a regular `http://` or `https://` webpage and click the AirSign toolbar icon to open the side panel.

### 4. Start AirSign

1. Click **Start AirSign** in the side panel.
2. On the first run, Chrome may open a one-time camera permission page because the initial camera prompt is not reliably shown from a side panel.
3. Click **Allow camera access** on that page and approve the browser permission prompt.
4. Return to the side panel. The live camera preview and hand tracking should run there for normal use.
5. Switch to the webpage you want to control and try the gestures above.

If you have just reloaded or reinstalled AirSign, reload any webpages that were already open so the current page-control script is loaded.

## How it works

AirSign is a Manifest V3 Chrome extension with a side-panel interface and a page-control bridge.

1. **Capture and tracking — `sidepanel.js`:** Accesses the webcam, runs MediaPipe Hands, classifies hand poses, and maps fingertip/palm coordinates into normalized screen coordinates.
2. **Message routing — `service-worker.js`:** Routes gesture data from the side panel to the currently selected, supported webpage.
3. **Cursor and webpage events — `content.js`:** Renders the virtual cursor, highlights interactive elements, and dispatches mouse events for click and drag interactions.
4. **First-time permission — `permission.html` and `permission.js`:** Provides a normal-tab flow for granting webcam permission when Chrome dismisses the side-panel prompt.
5. **Local runtime setup — `setup.bat` and `scripts/prepare-vendor.cjs`:** Installs the pinned MediaPipe package and copies required model/WASM assets into `vendor/`.

## Project structure

```text
AirSign/
├── icons/                    # Extension icons
├── scripts/
│   └── prepare-vendor.cjs    # Copies MediaPipe runtime assets into vendor/
├── vendor/                   # Local MediaPipe model/WASM assets (prepared by setup)
├── content.js                # Webpage cursor and gesture actions
├── manifest.json             # Chrome extension manifest
├── permission.html           # One-time camera permission page
├── permission.js             # Camera permission bootstrap logic
├── service-worker.js         # Routes gesture messages to webpages
├── sidepanel.css             # Side-panel styles
├── sidepanel.html            # Side-panel interface
├── sidepanel.js              # Webcam, MediaPipe, gesture recognition
├── setup.bat                 # Windows setup helper
├── package.json              # Pinned MediaPipe dependency and setup script
└── LICENSE                   # MIT license
```

## Privacy and permissions

- **Camera:** Used to capture frames for local hand tracking. AirSign does not upload webcam video to a server.
- **Host access:** AirSign requests access to HTTP and HTTPS webpages so it can inject the virtual cursor and deliver gesture actions to the selected page.
- **Browser restrictions:** Chrome does not permit extensions to control protected pages such as `chrome://` pages or the Chrome Web Store.
- **Setup network access:** The initial setup downloads the pinned MediaPipe package. After preparation, the extension loads its model and WASM runtime from the local `vendor/` directory.

Review `manifest.json` to see the extension permissions requested by the current source.

## Troubleshooting

### The camera permission prompt is dismissed or does not appear

Use the one-time permission page opened by AirSign and choose **Allow camera access**. If access was blocked previously, open `chrome://settings/content/camera`, allow camera access, and select the intended webcam. Close other apps that may be using the camera, then try again.

### MediaPipe fails to load or reports a missing asset

Run `setup.bat` again from the repository folder and wait for it to finish. Then open `chrome://extensions`, reload AirSign, and reload the webpage you want to control.

### The cursor does not appear or the page bridge is disconnected

- Make sure the active page is a normal `http://` or `https://` webpage.
- Reload the target webpage with `Ctrl+R` after updating or reloading the extension.
- Start AirSign again from the side panel while the intended webpage is active.
- Check the status and error message shown in the AirSign side panel.

### A click or drag does not work on a particular website

AirSign dispatches scripted mouse events. Some websites or controls require trusted physical input or use custom interaction handling, so every site or widget may not be compatible.

## Known limitations

- Chrome internal pages and Chrome Web Store pages cannot be controlled.
- The webcam must have a clear view of your hand; lighting and camera angle affect tracking.
- Website compatibility varies, especially for controls that require trusted user input.
- AirSign is an experimental project; test carefully before relying on it for important actions.

## Contributing

Ideas, bug reports, and improvements are welcome. When reporting an issue, include your Chrome version, the webpage type (without sharing private information), the gesture you tried, and the exact AirSign error message.

## License

AirSign is released under the [MIT License](LICENSE).

## Acknowledgements

Built with [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) for browser-based hand tracking.
