'use strict';

const grantBtn = document.getElementById('grantBtn');
const settingsBtn = document.getElementById('settingsBtn');
const closeBtn = document.getElementById('closeBtn');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const leadEl = document.getElementById('lead');

let busy = false;
let finished = false;

function describe(error) {
  const name = error && error.name ? error.name : 'Error';
  const message = error && error.message ? error.message : String(error || 'Unknown error');
  return `${name}: ${message}`;
}

function setStatus(text, kind = '') {
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  statusEl.replaceChildren();
  if (kind === 'busy') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    statusEl.append(spinner, document.createTextNode(text));
    return;
  }
  statusEl.textContent = text;
}

function broadcast(type, extra = {}) {
  try {
    chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
  } catch (_) { /* the panel may already be gone */ }
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch (_) {}
  }
}

function closeLater(delay = 1500) {
  setTimeout(() => {
    try { window.close(); } catch (_) {}
  }, delay);
}

async function requestCamera() {
  if (busy || finished) return;
  busy = true;
  grantBtn.disabled = true;
  grantBtn.textContent = 'Requesting camera…';
  setStatus('Waiting for Chrome… choose “Allow” in the prompt.', 'busy');

  let stream;
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('This page has no camera API. Update Chrome and try again.');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });

    // Only permission matters here; close the camera immediately.
    stopStream(stream);
    stream = null;
    finished = true;
    busy = false;

    document.body.classList.add('granted');
    titleEl.textContent = 'Camera access granted';
    leadEl.replaceChildren(document.createTextNode('Returning to AirSign and starting hand tracking. '));
    const strong = document.createElement('strong');
    strong.textContent = 'You can close this tab if it stays open.';
    leadEl.appendChild(strong);

    grantBtn.hidden = true;
    settingsBtn.hidden = true;
    closeBtn.hidden = false;
    setStatus('Access granted. Starting tracking in the side panel…', 'success');
    broadcast('AIRSIGN_CAMERA_PERMISSION_GRANTED');
    closeLater();
  } catch (error) {
    stopStream(stream);
    busy = false;
    grantBtn.disabled = false;
    grantBtn.textContent = 'Try again';
    settingsBtn.hidden = false;

    const name = error && error.name;
    let message;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      message = 'Camera access was blocked. Click the camera icon in Chrome’s address bar and choose “Always allow”, or open Chrome settings below.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      message = 'No camera was found. Connect a webcam, then try again.';
    } else if (name === 'NotReadableError') {
      message = 'The camera is busy in another app. Close the other app, then try again.';
    } else {
      message = `The camera could not start (${describe(error)}).`;
    }

    setStatus(message, 'error');
    broadcast('AIRSIGN_CAMERA_PERMISSION_FAILED', { error: describe(error) });
  }
}

grantBtn.addEventListener('click', requestCamera);

settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/content/camera' }).catch(() => {});
});

closeBtn.addEventListener('click', () => {
  try { window.close(); } catch (_) {}
});

(async function init() {
  try {
    const permission = await navigator.permissions.query({ name: 'camera' });
    if (permission.state === 'granted') {
      grantBtn.textContent = 'Check camera access';
      setStatus('Chrome already allows camera access for AirSign. Click below to verify it and return.');
    } else if (permission.state === 'denied') {
      setStatus('Camera access is currently blocked. Open Chrome settings to allow it for AirSign.', 'error');
      settingsBtn.hidden = false;
      grantBtn.textContent = 'Try anyway';
    }
  } catch (_) {
    // Permissions.query is unavailable in some Chrome builds; the button still works.
  }
})();
