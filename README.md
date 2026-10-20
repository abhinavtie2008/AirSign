# AirSign 
###(Browse the web without touching anything)


AirSign is a lightweight browser extension designed for seamless air-gesture and sign recognition directly in your browser. This repository contains both the core Chrome extension source code and a live testing sandbox.

AirSign runs webcam capture and MediaPipe hand tracking directly in the Chrome side panel. It sends hand landmarks/gesture coordinates through the extension service worker to the selected normal HTTP(S) webpage.

## Setup
1. Install Node.js LTS if needed.
2. Run `setup.bat` once from this folder while connected to the internet. It installs the pinned MediaPipe package and copies model/WASM assets into `vendor/`.
3. In Chrome, open `chrome://extensions`, enable Developer mode, and click **Load unpacked**. Select this `airsign-extension` folder.
4. Open a normal `http://` or `https://` webpage and click the AirSign toolbar icon.
5. Click **Start AirSign** in the side panel. If Chrome has not granted camera access to AirSign yet, a one-time normal tab opens to grant it. After access is granted, the camera preview and tracking run in the side panel; ordinary starts should not open a tracker tab.

## Chrome camera-permission limitation
Chrome does not reliably show the first `getUserMedia()` permission prompt from a side panel. This build checks for an existing grant and otherwise opens `permission.html` only for the initial grant. The permission tab stops its temporary stream and closes; AirSign then requests/uses the already granted camera from the side panel. If Chrome permission has been reset or blocked, repeat the grant flow.

## Gestures
- Index finger: move cursor
- Thumb-index pinch: click
- Fist: drag
- Index + middle fingers: scroll

The controlled page must be a normal HTTP(S) webpage. Chrome internal pages and Chrome Web Store pages cannot be controlled. Video frames stay within the extension on the device.
