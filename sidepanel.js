import {
  createGestureEngine,
  derivePinchCalibration,
  DWELL_DEFAULT_MS,
  GESTURE_VERSION,
  HAND_CONNECTIONS,
  normalizeDwellMs,
  normalizePinchCalibration,
  POSE_LABELS
} from './lib/gestures.mjs';

const VERSION = GESTURE_VERSION;
const SETTINGS_KEY = 'airsignSettings';
const PAUSED_KEY = 'airsignPausedSites';
const DETECT_INTERVAL_MS = 1000 / 30;
const CALIBRATION_CAPTURE_MS = 1400;
const CALIBRATION_PINCH_WAIT_MS = 6000;

const DEFAULT_SETTINGS = Object.freeze({ reach: 'balanced', smoothing: 35, mirror: true, assist: true, dwell: false, dwellMs: DWELL_DEFAULT_MS, calibration: null });
const REACH_HINTS = {
  compact: 'Small hand travel',
  balanced: 'Comfortable hand travel',
  wide: 'Large, precise hand travel'
};
const CHIP_LABELS = {
  none: 'NO HAND',
  idle: 'OPEN HAND',
  point: 'POINT',
  click: 'CLICK',
  drag: 'FIST',
  scroll: 'SCROLL'
};
const STATUS_LABELS = {
  point: 'Pointing',
  click: 'Pinching',
  drag: 'Dragging',
  scroll: 'Scrolling',
  idle: 'Hand detected'
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const preview = $('preview');
const ctx = preview.getContext('2d');
const startBtn = $('startBtn');
const startLabel = $('startLabel');
const stopBtn = $('stopBtn');
const bubbleBtn = $('bubbleBtn');
const statusDot = $('statusDot');
const cameraState = $('cameraState');
const cameraBadge = document.querySelector('.camera-badge');
const cameraPlaceholder = $('cameraPlaceholder');
const gestureChip = $('gestureChip');
const trackingStatus = $('trackingStatus');
const handPill = $('handPill');
const fpsLabel = $('fpsLabel');
const targetTitle = $('targetTitle');
const targetUrl = $('targetUrl');
const bridgeState = $('bridgeState');
const sitePauseBtn = $('sitePauseBtn');
const messageEl = $('message');
const sandboxBtn = $('sandboxBtn');
const tuning = $('tuning');
const tuningSummary = $('tuningSummary');
const reachHint = $('reachHint');
const smoothingInput = $('smoothing');
const smoothingValue = $('smoothingValue');
const mirrorInput = $('mirror');
const assistInput = $('assist');
const dwellInput = $('dwell');
const dwellMsInput = $('dwellMs');
const dwellMsValue = $('dwellMsValue');
const reachButtons = [...document.querySelectorAll('[data-reach]')];
const calibrationCard = $('calibrationCard');
const calibrationStep = $('calibrationStep');
const calibrationTitle = $('calibrationTitle');
const calibrationCopy = $('calibrationCopy');
const calibrationMeter = document.querySelector('.calibration-meter');
const calibrationBar = $('calibrationBar');
const calibrationLive = $('calibrationLive');
const calibrationRetry = $('calibrationRetry');
const calibrationCancel = $('calibrationCancel');
const calibrationState = $('calibrationState');
const calibrateBtn = $('calibrateBtn');
const resetCalibrationBtn = $('resetCalibrationBtn');

let settings = { ...DEFAULT_SETTINGS };
let engine = createGestureEngine(settings);

let currentWindowId = null;
let target = null;
let previewTab = null;
let running = false;
let starting = false;
let waitingForPermission = false;
let suspended = false;
let sitePaused = false;
let pausedSites = new Set();
let bubbleActive = false;
let permissionTabId = null;
let stream = null;
let landmarker = null;
let loopId = 0;
let processing = false;
let lastDetectAt = 0;
let lastVideoTs = 0;
let lastSentHand = false;
let startAttempt = 0;
let targetToken = 0;
let bridgeRecovering = false;
let lastFrameProblemAt = 0;
let lastErrorNoticeAt = 0;
let fpsFrames = 0;
let fpsWindowStart = 0;
let settingsSaveTimer = 0;
let lastRenderedTargetKey = '';
let calibration = null;
let calibrationPending = false;
let calibrationCloseTimer = 0;

class AirSignError extends Error {
  constructor(message, actions = []) {
    super(message);
    this.name = 'AirSignError';
    this.actions = actions;
  }
}

function explain(error) {
  if (!error) return 'Unknown error';
  const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
  return `${name}${error.message || String(error)}`;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function readCalibration(value) {
  const normalized = normalizePinchCalibration(value);
  if (!normalized) return null;
  const optional = (key) => (Number.isFinite(value[key]) ? value[key] : null);
  return {
    ...normalized,
    openRatio: optional('openRatio'),
    closedRatio: optional('closedRatio'),
    handWidth: optional('handWidth'),
    at: optional('at')
  };
}

function percentile(values, fraction) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * fraction, 0, sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function median(values) {
  return percentile(values, 0.5);
}

function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function sandboxUrl() {
  return chrome.runtime.getURL('sandbox.html');
}

function isSandboxUrl(url) {
  return typeof url === 'string' && url.startsWith(sandboxUrl());
}

function isEligible(tab) {
  return Boolean(tab && Number.isInteger(tab.id) && (isWebUrl(tab.url) || isSandboxUrl(tab.url)));
}

function siteOrigin(tab) {
  if (!tab || !isWebUrl(tab.url)) return null;
  try {
    return new URL(tab.url).origin;
  } catch (_) {
    return null;
  }
}

function siteHost(tab) {
  const origin = siteOrigin(tab);
  if (!origin) return '';
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch (_) {
    return origin;
  }
}

function isPausedSite(tab) {
  const origin = siteOrigin(tab);
  return Boolean(origin && pausedSites.has(origin));
}

async function loadPausedSites() {
  try {
    const stored = await chrome.storage.local.get(PAUSED_KEY);
    const list = stored && stored[PAUSED_KEY];
    pausedSites = new Set(Array.isArray(list) ? list.filter((value) => typeof value === 'string' && value) : []);
  } catch (_) {
    pausedSites = new Set();
  }
}

async function savePausedSites() {
  try {
    await chrome.storage.local.set({ [PAUSED_KEY]: [...pausedSites] });
  } catch (error) {
    console.warn('AirSign could not save paused sites:', error);
  }
}

async function toggleSitePause() {
  const tab = running ? target : previewTab;
  const origin = siteOrigin(tab);
  if (!origin) return;
  const nowPaused = !pausedSites.has(origin);
  if (nowPaused) pausedSites.add(origin);
  else pausedSites.delete(origin);
  await savePausedSites();

  if (running && target && siteOrigin(target) === origin) {
    if (nowPaused) {
      await suspendTracking(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site to take control back.`, { site: true });
    } else {
      await resumeTracking(target);
    }
  } else {
    renderTarget();
  }
}

function prettyUrl(url) {
  if (!url) return '—';
  if (isSandboxUrl(url)) return 'AirSign test page';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'chrome:') return parsed.pathname === '/extensions' ? 'chrome://extensions' : 'Browser page';
    if (parsed.protocol === 'chrome-extension:') return 'Extension page';
    if (parsed.protocol === 'file:') return 'Local file';
    if (parsed.protocol === 'chrome-search:' || parsed.protocol === 'edge:') return 'Browser page';
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host.replace(/^www\./, '')}${path}`;
  } catch (_) {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function setMessage(text, kind = '', actions = []) {
  messageEl.className = `message${kind ? ` ${kind}` : ''}`;
  messageEl.replaceChildren(document.createTextNode(text));
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    messageEl.appendChild(button);
  }
}

function setStatusDot(mode) {
  statusDot.className = `status-dot${mode ? ` ${mode}` : ''}`;
  statusDot.title = { on: 'Tracking', starting: 'Starting', error: 'Error' }[mode] || 'Stopped';
}

function setCameraLive(live) {
  cameraState.textContent = live ? 'CAMERA LIVE' : 'CAMERA OFF';
  cameraBadge.classList.toggle('live', live);
  cameraPlaceholder.hidden = live;
}

function setGestureChip(pose) {
  const key = pose && CHIP_LABELS[pose] ? pose : 'none';
  gestureChip.textContent = CHIP_LABELS[key];
  gestureChip.className = `gesture-chip${key !== 'none' ? ` ${key}` : ''}`;
}

function setHandState(detected) {
  handPill.textContent = detected ? 'HAND DETECTED' : 'NO HAND';
  handPill.classList.toggle('detected', Boolean(detected));
}

function setTracking(text) {
  if (trackingStatus.textContent !== text) trackingStatus.textContent = text;
}

function setFps(fps) {
  fpsLabel.textContent = fps ? `${Math.round(fps)} FPS` : '— FPS';
}

function setBridge(kind, label) {
  bridgeState.className = `bridge-state${kind ? ` ${kind}` : ''}`;
  bridgeState.textContent = label;
}

function updateControls() {
  startBtn.classList.remove('running', 'waiting');
  if (bubbleActive) {
    startBtn.disabled = true;
    startLabel.textContent = 'In camera bubble';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    bubbleBtn.hidden = true;
    return;
  }
  bubbleBtn.hidden = !running;
  bubbleBtn.disabled = Boolean(calibration);
  if (running) {
    startBtn.disabled = true;
    startBtn.classList.add('running');
    startLabel.textContent = 'AirSign running';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
  } else if (starting) {
    startBtn.disabled = true;
    startBtn.classList.add('waiting');
    startLabel.textContent = 'Starting…';
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stop';
  } else if (waitingForPermission) {
    startBtn.disabled = true;
    startBtn.classList.add('waiting');
    startLabel.textContent = 'Waiting for permission';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Cancel';
  } else {
    startBtn.disabled = false;
    startLabel.textContent = 'Start AirSign';
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stop';
  }
}

function renderTarget() {
  const tab = running ? target : previewTab || target;
  const key = tab ? `${tab.id}|${tab.title}|${tab.url}|${suspended}|${sitePaused}|${running}|${target?.bridgeReady}` : 'none';
  if (key !== lastRenderedTargetKey) {
    lastRenderedTargetKey = key;
    if (tab) {
      targetTitle.textContent = tab.title || 'Untitled page';
      targetTitle.title = tab.title || '';
      targetUrl.textContent = prettyUrl(tab.url);
      targetUrl.title = tab.url || '';
    } else {
      targetTitle.textContent = 'No page selected';
      targetTitle.title = '';
      targetUrl.textContent = 'Open a website or the test page.';
      targetUrl.title = '';
    }
  }

  if (!tab) {
    setBridge('', '—');
  } else if (sitePaused) {
    setBridge('warn', 'Site paused');
  } else if (suspended) {
    setBridge('warn', 'Paused');
  } else if (bubbleActive) {
    setBridge('ok', 'In bubble');
  } else if (running) {
    if (target?.bridgeReady) setBridge('ok', 'Connected');
    else if (target) setBridge('warn', 'Connecting');
    else setBridge('', 'No target');
  } else if (isEligible(tab)) {
    setBridge('', 'Ready');
  } else {
    setBridge('warn', 'Protected');
  }

  renderSitePause();
}

function renderSitePause() {
  const tab = running ? target : previewTab || target;
  const origin = siteOrigin(tab);
  sitePauseBtn.hidden = !origin;
  if (!origin) return;
  const paused = pausedSites.has(origin);
  const host = siteHost(tab);
  sitePauseBtn.textContent = paused ? `Resume on ${host}` : `Pause on ${host}`;
  sitePauseBtn.dataset.paused = String(paused);
  sitePauseBtn.title = paused
    ? `Gestures stay off on ${origin} until you resume.`
    : `Turn gestures off while you are on ${origin}.`;
}

function applySettingsUI() {
  for (const button of reachButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.reach === settings.reach));
  }
  reachHint.textContent = REACH_HINTS[settings.reach] || REACH_HINTS.balanced;
  smoothingInput.value = String(settings.smoothing);
  smoothingValue.textContent = String(settings.smoothing);
  mirrorInput.checked = settings.mirror;
  assistInput.checked = settings.assist !== false;
  dwellInput.checked = settings.dwell === true;
  dwellMsInput.value = String(settings.dwellMs);
  dwellMsValue.textContent = `${settings.dwellMs} ms`;
  tuningSummary.textContent = `${settings.reach.charAt(0).toUpperCase()}${settings.reach.slice(1)} · ${settings.smoothing}${settings.dwell ? ' · Dwell' : ''}`;

  const calibrated = Boolean(settings.calibration);
  calibrationState.textContent = calibrated ? 'Calibrated' : 'Default';
  calibrationState.classList.toggle('calibrate-ok', calibrated);
  calibrationState.title = calibrated
    ? `Clicks at ${settings.calibration.pinchOn.toFixed(2)} · release at ${settings.calibration.pinchOff.toFixed(2)}`
    : 'Using the built-in thresholds';
  resetCalibrationBtn.disabled = !calibrated || Boolean(calibration);
  calibrateBtn.disabled = Boolean(calibration);
  calibrateBtn.textContent = calibration ? 'Calibrating…' : calibrated ? 'Recalibrate pinch' : 'Calibrate pinch';
}

function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
  }, 250);
}

function changeSettings(patch) {
  settings = { ...settings, ...patch };
  engine.configure(settings);
  applySettingsUI();
  scheduleSettingsSave();
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = stored && stored[SETTINGS_KEY];
    if (raw && typeof raw === 'object') {
      settings = {
        reach: raw.reach === 'compact' || raw.reach === 'wide' ? raw.reach : 'balanced',
        smoothing: Number.isFinite(raw.smoothing) ? clamp(raw.smoothing, 0, 100) : DEFAULT_SETTINGS.smoothing,
        mirror: raw.mirror !== false,
        assist: raw.assist !== false,
        dwell: raw.dwell === true,
        dwellMs: normalizeDwellMs(raw.dwellMs),
        calibration: readCalibration(raw.calibration)
      };
    }
  } catch (error) {
    console.warn('AirSign could not load settings:', error);
  }
  applySettingsUI();
  engine.configure(settings);
}

/* ------------------------------------------------------------------ */
/* Pinch calibration                                                   */
/* ------------------------------------------------------------------ */

function setCalibrationProgress(progress) {
  const percent = Math.round(clamp(progress, 0, 1) * 100);
  calibrationBar.style.width = `${percent}%`;
  calibrationMeter.setAttribute('aria-valuenow', String(percent));
}

function showCalibrationStep(step) {
  calibrationCard.hidden = false;
  calibrationRetry.hidden = true;
  calibrationCancel.hidden = false;
  calibrationCancel.textContent = 'Cancel';
  setCalibrationProgress(0);
  if (step === 'open') {
    calibrationStep.textContent = '1 / 2';
    calibrationTitle.textContent = 'Show an open hand';
    calibrationCopy.textContent = 'Hold your hand open, palm toward the camera, with all fingers inside the preview.';
    calibrationLive.textContent = 'Waiting for a hand…';
  } else if (step === 'pinch') {
    calibrationStep.textContent = '2 / 2';
    calibrationTitle.textContent = 'Now pinch';
    calibrationCopy.textContent = 'Touch your thumb and index fingertip together and hold. Keep the rest of your hand relaxed.';
    calibrationLive.textContent = 'Waiting for your pinch…';
  }
}

function beginCalibration() {
  if (calibration) return;
  if (!running) {
    if (starting || waitingForPermission) {
      calibrationPending = true;
      setMessage('Calibration will begin as soon as AirSign is running.', '');
      return;
    }
    calibrationPending = true;
    start();
    return;
  }

  clearTimeout(calibrationCloseTimer);
  calibration = {
    step: 'open',
    samples: [],
    elapsedMs: 0,
    lastAt: 0,
    waitSince: 0,
    open: null,
    handWidth: null
  };
  calibrationPending = false;
  if (target) sendStop(target);
  lastSentHand = false;
  engine.reset();
  engine.configure(settings);
  setStatusDot('starting');
  setTracking('Calibrating open hand');
  showCalibrationStep('open');
  applySettingsUI();
  if (tuning) tuning.open = false;
  setMessage('Calibration started. Page control pauses while AirSign learns your pinch.', '');
}

function clearCalibrationUI() {
  clearTimeout(calibrationCloseTimer);
  calibration = null;
  calibrationCard.hidden = true;
  calibrationRetry.hidden = true;
  calibrationCancel.hidden = false;
  calibrationCancel.textContent = 'Cancel';
  applySettingsUI();
}

function closeCalibration(notice = '', kind = 'success') {
  if (!calibration) return;
  clearCalibrationUI();
  lastSentHand = false;
  if (running) {
    engine.reset();
    engine.configure(settings);
    setStatusDot('on');
    setTracking(suspended ? 'Paused' : 'Looking for a hand');
    setGestureChip('none');
  } else {
    setStatusDot('');
  }
  if (notice) setMessage(notice, kind);
}

function retryCalibration() {
  if (!calibration) return;
  calibration.step = 'open';
  calibration.samples = [];
  calibration.elapsedMs = 0;
  calibration.lastAt = 0;
  calibration.waitSince = 0;
  calibration.open = null;
  calibration.handWidth = null;
  showCalibrationStep('open');
  setTracking('Calibrating open hand');
}

function feedCalibration(frame, now) {
  if (!calibration) return;
  const step = calibration.step;
  if (step !== 'open' && step !== 'pinch') return;

  const handPresent = frame.handPresent;
  // Step 2 must see the fingers actually close relative to the open-hand
  // measurement. Otherwise an open hand held through the step would be
  // recorded as pinch data and fail the calibration for no reason.
  const closing = step === 'pinch' && handPresent && frame.pinchRatio < calibration.open * 0.8;
  const ready = step === 'open'
    ? handPresent && !frame.pinchActive && frame.raw !== 'drag'
    : closing && frame.raw !== 'drag';
  if (!ready) {
    calibration.lastAt = 0;
    if (step === 'pinch' && handPresent) {
      calibration.waitSince = calibration.waitSince || now;
      if (now - calibration.waitSince > CALIBRATION_PINCH_WAIT_MS) {
        finishCalibration();
        return;
      }
      calibrationLive.textContent = 'Touch your thumb and index tips together.';
    } else {
      calibrationLive.textContent = !handPresent
        ? 'No hand yet — move into the camera preview.'
        : 'Open your fingers and keep the hand in view.';
    }
    return;
  }

  calibration.waitSince = 0;

  const delta = calibration.lastAt ? Math.min(now - calibration.lastAt, 100) : 33;
  calibration.lastAt = now;
  calibration.elapsedMs += delta;
  calibration.samples.push(frame.pinchRatio);
  if (step === 'open' && Number.isFinite(frame.handWidth) && frame.handWidth > 0.05) {
    calibration.handWidth = calibration.handWidth === null
      ? frame.handWidth
      : calibration.handWidth * 0.9 + frame.handWidth * 0.1;
  }

  const progress = Math.min(1, calibration.elapsedMs / CALIBRATION_CAPTURE_MS);
  setCalibrationProgress(progress);
  calibrationLive.textContent = progress >= 1
    ? 'Captured'
    : step === 'open'
      ? `Hold still · ${Math.round(progress * 100)}%`
      : `Pinch held · ${Math.round(progress * 100)}%`;
  if (calibration.elapsedMs < CALIBRATION_CAPTURE_MS) return;

  if (step === 'open') {
    calibration.open = median(calibration.samples);
    calibration.samples = [];
    calibration.elapsedMs = 0;
    calibration.lastAt = 0;
    calibration.step = 'pinch';
    showCalibrationStep('pinch');
    setTracking('Calibrating pinch');
  } else {
    finishCalibration();
  }
}

function finishCalibration() {
  const captured = derivePinchCalibration(
    calibration.open,
    percentile(calibration.samples, 0.35),
    calibration.handWidth ?? NaN
  );

  if (!captured) {
    calibration.step = 'failed';
    setCalibrationProgress(0);
    calibrationStep.textContent = 'RETRY';
    calibrationTitle.textContent = 'Pinch not clear';
    calibrationCopy.textContent = 'Your pinched fingers looked almost the same as your open hand. Touch the thumb and index tips together and try again.';
    calibrationLive.textContent = 'Your old settings are unchanged.';
    calibrationRetry.hidden = false;
    setTracking('Calibration needs a retry');
    return;
  }

  calibration.step = 'success';
  setCalibrationProgress(1);
  changeSettings({ calibration: { ...captured, at: Date.now() } });
  calibrationStep.textContent = 'DONE';
  calibrationTitle.textContent = 'Pinch calibrated';
  calibrationCopy.textContent = 'AirSign now matches your own thumb-to-index distance, so a relaxed hand will not click by accident.';
  calibrationLive.textContent = `Click at ${captured.pinchOn.toFixed(2)} · release at ${captured.pinchOff.toFixed(2)}`;
  calibrationRetry.hidden = true;
  calibrationCancel.textContent = 'Done';
  calibrationCancel.hidden = false;
  setStatusDot('on');
  setTracking('Pinch calibrated');
  calibrationCloseTimer = setTimeout(() => {
    closeCalibration('Pinch calibrated. Point at the page to keep browsing.', 'success');
  }, 2800);
}

/* ------------------------------------------------------------------ */
/* Targets and page bridge                                             */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return (tabs && tabs[0]) || null;
}

async function findBestTarget() {
  const active = await getActiveTab();
  if (isEligible(active)) return active;

  // In a side panel the active tab is the page being browsed, but if focus is
  // somewhere else (DevTools, our own test page in a tab) fall back to the most
  // recently used controllable tab instead of failing outright.
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true }).catch(() => []);
  const candidates = tabs.filter(isEligible).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0] || null;
}

async function updatePreview(tab = null) {
  if (running) return;
  if (tab) previewTab = tab;
  else previewTab = await getActiveTab();
  renderTarget();
}

async function pingTarget(tab) {
  const message = { type: 'AIRSIGN_PING' };
  const reply = tab.kind === 'sandbox'
    ? await chrome.runtime.sendMessage(message)
    : await chrome.tabs.sendMessage(tab.tabId, message);

  if (!reply || reply.ok !== true) {
    throw new Error('The page did not respond.');
  }
  if (reply.version !== VERSION) {
    throw new Error(`This page has an older AirSign bridge. Reload it with Ctrl+R, then try again.`);
  }
  return reply;
}

async function ensureBridge(tab, token) {
  if (!Number.isInteger(tab.tabId)) throw new Error('No webpage is selected.');

  let reply;
  try {
    reply = await pingTarget(tab);
  } catch (firstError) {
    if (tab.kind === 'sandbox') {
      throw new Error('The test page is not ready yet. Reload it and try again.');
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, files: ['content.js'] });
      reply = await pingTarget(tab);
    } catch (secondError) {
      throw new Error(`Could not reach this page (${explain(secondError)}). Reload it with Ctrl+R, then try again.`);
    }
  }

  if (token !== undefined && token !== targetToken) return reply;
  if (!target || target.tabId !== tab.tabId) return reply;

  target.bridgeReady = true;
  if (reply.title) target.title = reply.title;
  if (reply.href) target.url = reply.href;
  renderTarget();
  return reply;
}

function sendStop(tab) {
  if (!tab) return;
  if (tab.kind === 'sandbox') {
    chrome.runtime.sendMessage({ type: 'AIRSIGN_STOP' }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.tabId, { type: 'AIRSIGN_STOP' }).catch(() => {});
  }
}

async function activateTarget(tab, { announce = true, throwOnError = false } = {}) {
  if (!isEligible(tab)) {
    const error = new AirSignError('Your browser protects this page. Switch to a regular http:// or https:// website.', [
      { label: 'Open test page', onClick: openSandbox }
    ]);
    if (throwOnError) throw error;
    return false;
  }

  const token = ++targetToken;
  const previous = target;
  if (previous && previous.tabId !== tab.id) sendStop(previous);

  target = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || prettyUrl(tab.url),
    kind: isSandboxUrl(tab.url) ? 'sandbox' : 'web',
    bridgeReady: false
  };
  sitePaused = isPausedSite(target);
  suspended = sitePaused;
  previewTab = tab;
  lastRenderedTargetKey = '';
  setBridge('warn', sitePaused ? 'Site paused' : 'Connecting');
  renderTarget();

  if (sitePaused) {
    if (running) {
      setTracking('Paused on this site');
      setMessage(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site to take control back.`, 'warn');
    }
    return true;
  }

  try {
    await ensureBridge(target, token);
    if (token !== targetToken) return false;
    if (announce && running) {
      setMessage(`Controlling “${target.title}”. Move your hand to bring the cursor over.`, 'success');
    }
    return true;
  } catch (error) {
    if (token !== targetToken) return false;
    if (target) target.bridgeReady = false;
    setBridge('error', 'Not connected');
    if (throwOnError) throw error;
    setMessage(`Camera is on, but this page can't be controlled yet: ${error.message}`, 'error');
    return false;
  }
}

async function suspendTracking(reason, { site = false } = {}) {
  if (!running) return;
  suspended = true;
  sitePaused = site;
  sendStop(target);
  renderTarget();
  setTracking(site ? 'Paused on this site' : 'Paused');
  setMessage(reason || 'AirSign is paused while this page is open. Switch back to a regular webpage.', 'warn');
}

async function resumeTracking(tab) {
  suspended = false;
  sitePaused = false;
  renderTarget();
  try {
    await ensureBridge(target, targetToken);
    suspended = false;
    renderTarget();
    setTracking('Looking for a hand');
    setMessage(`Back on “${target.title}”. Tracking is live.`, 'success');
  } catch (error) {
    setMessage(`Could not resume control of this page: ${error.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Camera and model                                                    */
/* ------------------------------------------------------------------ */

async function cameraPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state;
  } catch (_) {
    return 'unknown';
  }
}

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new AirSignError('This browser context has no camera API. Update your browser and reload the extension.');
  }

  const permission = await cameraPermissionState();
  if (permission === 'denied') {
    const error = new AirSignError('Camera access is blocked for AirSign. Allow the camera in your browser settings, then try again.', [
      { label: 'Camera settings', onClick: () => chrome.tabs.create({ url: 'chrome://settings/content/camera' }) },
      { label: 'Retry', onClick: () => start() }
    ]);
    error.code = 'CAMERA_BLOCKED';
    throw error;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
  } catch (error) {
    if (error && error.name === 'NotAllowedError') {
      const permissionError = new AirSignError('Your browser did not grant camera access from the side panel.');
      permissionError.code = 'CAMERA_PROMPT';
      throw permissionError;
    }
    if (error && error.name === 'NotFoundError') {
      throw new AirSignError('No camera was found on this device.');
    }
    if (error && error.name === 'NotReadableError') {
      throw new AirSignError('The camera is busy in another app. Close it there and try again.');
    }
    throw new AirSignError(`Could not open the camera (${explain(error)}).`);
  }

  try {
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    stopStream();
    throw new AirSignError(`The camera started but could not display a preview (${explain(error)}).`);
  }

  preview.width = 640;
  preview.height = 480;
  setCameraLive(true);
  drawPreview(null);
}

async function createLandmarker() {
  let vision;
  try {
    const module = await import('./vendor/vision_bundle.mjs');
    const { FilesetResolver, HandLandmarker } = module;
    vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
    const options = {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('vendor/hand_landmarker.task'),
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    };
    try {
      return await HandLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn('AirSign: GPU delegate unavailable, falling back to CPU.', gpuError);
      options.baseOptions.delegate = 'CPU';
      return await HandLandmarker.createFromOptions(vision, options);
    }
  } catch (error) {
    throw new AirSignError(`The hand-tracking model could not be loaded (${explain(error)}). Reload AirSign from chrome://extensions and try again.`);
  }
}

function drawPreview(landmarks, pose = 'none') {
  const w = preview.width;
  const h = preview.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#06080f';
  ctx.fillRect(0, 0, w, h);

  if (video.videoWidth && video.videoHeight) {
    const sourceAspect = video.videoWidth / video.videoHeight;
    const targetAspect = w / h;
    let sx = 0;
    let sy = 0;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    if (sourceAspect > targetAspect) {
      sw = video.videoHeight * targetAspect;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = video.videoWidth / targetAspect;
      sy = (video.videoHeight - sh) / 2;
    }
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    ctx.restore();

    const mapX = (value) => {
      const mirrored = 1 - value;
      return ((mirrored * video.videoWidth - sx) / sw) * w;
    };
    const mapY = (value) => ((value * video.videoHeight - sy) / sh) * h;

    const colors = {
      click: '#34d399',
      drag: '#fbbf24',
      scroll: '#fbbf24',
      point: '#22d3ee',
      idle: 'rgba(34, 211, 238, .7)',
      none: '#22d3ee'
    };
    const lineColor = colors[pose] || colors.none;
    const alpha = pose === 'idle' ? 0.6 : 0.95;

    if (landmarks && landmarks.length >= 21) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = lineColor;
      ctx.lineCap = 'round';
      ctx.shadowColor = lineColor;
      ctx.shadowBlur = 8;
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(mapX(landmarks[a].x), mapY(landmarks[a].y));
        ctx.lineTo(mapX(landmarks[b].x), mapY(landmarks[b].y));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < landmarks.length; i += 1) {
        const point = landmarks[i];
        ctx.beginPath();
        ctx.arc(mapX(point.x), mapY(point.y), i === 8 || i === 4 ? 4.2 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.arc(mapX(landmarks[8].x), mapY(landmarks[8].y), 13, 0, Math.PI * 2);
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function countFps(now) {
  fpsFrames += 1;
  if (!fpsWindowStart) fpsWindowStart = now;
  if (now - fpsWindowStart >= 1000) {
    setFps((fpsFrames * 1000) / (now - fpsWindowStart));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

function sendFrame(frame) {
  if (!running || !target || !target.bridgeReady || suspended) return;
  const payload = {
    handPresent: Boolean(frame.handPresent),
    pose: frame.pose,
    x: frame.x,
    y: frame.y,
    palmX: frame.palmX,
    palmY: frame.palmY,
    scrollY: frame.scrollY,
    pinchRatio: frame.pinchRatio,
    assist: settings.assist !== false,
    dwellMs: settings.dwell === true ? settings.dwellMs : 0,
    at: frame.at
  };

  const current = target;
  const failed = () => handleFrameProblem(current);

  if (current.kind === 'sandbox') {
    chrome.runtime.sendMessage({ type: 'AIRSIGN_FRAME', payload }).then((reply) => {
      if (!reply || reply.ok !== true) failed();
    }).catch(failed);
  } else {
    chrome.tabs.sendMessage(current.tabId, { type: 'AIRSIGN_FRAME', payload }).then((reply) => {
      if (!reply || reply.ok !== true) failed();
    }).catch(failed);
  }
}

async function handleFrameProblem(tab) {
  const now = performance.now();
  if (bridgeRecovering || now - lastFrameProblemAt < 1500) return;
  if (!target || !tab || target.tabId !== tab.tabId) return;
  lastFrameProblemAt = now;
  bridgeRecovering = true;
  target.bridgeReady = false;
  setBridge('warn', 'Reconnecting');
  try {
    await ensureBridge(target, targetToken);
  } catch (error) {
    if (running) {
      setBridge('error', 'Disconnected');
      if (now - lastErrorNoticeAt > 4000) {
        lastErrorNoticeAt = now;
        setMessage(`Lost the page connection (${error.message}). Reload the page, then switch to it again.`, 'error');
      }
    }
  } finally {
    bridgeRecovering = false;
  }
}

function applyFrameToUI(frame) {
  if (!frame.handPresent) {
    setHandState(false);
    setGestureChip('none');
    if (running && !suspended && !calibration) setTracking('Looking for a hand');
    return;
  }
  setHandState(true);
  setGestureChip(frame.pose);
  if (running && !suspended && !calibration) setTracking(STATUS_LABELS[frame.pose] || POSE_LABELS[frame.pose] || 'Tracking');
}

function startLoop() {
  stopLoop();
  lastDetectAt = 0;
  lastVideoTs = 0;
  fpsFrames = 0;
  fpsWindowStart = performance.now();

  const tick = () => {
    if (!running) return;
    loopId = requestAnimationFrame(tick);
    const now = performance.now();
    if (processing || now - lastDetectAt < DETECT_INTERVAL_MS) return;
    if (!video.videoWidth || !landmarker) return;

    lastDetectAt = now;
    processing = true;
    try {
      const timestamp = Math.max(Math.round(now), lastVideoTs + 1);
      lastVideoTs = timestamp;
      const results = landmarker.detectForVideo(video, timestamp);
      const hand = results.landmarks && results.landmarks[0] ? results.landmarks[0] : null;
      const frame = engine.update(hand, now);
      drawPreview(hand, frame.handPresent ? frame.pose : 'none');
      applyFrameToUI(frame);

      if (calibration) {
        feedCalibration(frame, now);
        lastSentHand = false;
      } else if (frame.handPresent) {
        sendFrame(frame);
        lastSentHand = true;
      } else if (lastSentHand) {
        // One no-hand frame is enough: the page bridge hides the cursor after
        // its own timeout, so don't stream "no hand" at 30fps forever.
        sendFrame(frame);
        lastSentHand = false;
      }
      countFps(now);
    } catch (error) {
      const now2 = performance.now();
      console.error('AirSign detection error:', error);
      if (now2 - lastErrorNoticeAt > 4000) {
        lastErrorNoticeAt = now2;
        setMessage(`Hand tracking hit an error: ${explain(error)}`, 'error');
      }
    } finally {
      processing = false;
    }
  };

  loopId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (loopId) cancelAnimationFrame(loopId);
  loopId = 0;
  processing = false;
}

function stopStream() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  try {
    video.pause();
    video.srcObject = null;
  } catch (_) {}
}

function closeLandmarker() {
  if (landmarker) {
    try { landmarker.close(); } catch (_) {}
    landmarker = null;
  }
}

function drawIdlePreview() {
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.fillStyle = '#06080f';
  ctx.fillRect(0, 0, preview.width, preview.height);
}

function cleanupTrackingUI() {
  stopLoop();
  stopStream();
  closeLandmarker();
  clearCalibrationUI();
  drawIdlePreview();
  setCameraLive(false);
  setHandState(false);
  setGestureChip('none');
  setTracking('Not started');
  setFps(0);
}

/* ------------------------------------------------------------------ */
/* Permission flow                                                     */
/* ------------------------------------------------------------------ */

async function openPermissionTab() {
  if (waitingForPermission) return;
  waitingForPermission = true;
  updateControls();
  setStatusDot('starting');
  try {
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html'), active: true });
    permissionTabId = tab.id || null;
  } catch (error) {
    waitingForPermission = false;
    updateControls();
    setStatusDot('');
    setMessage(`Could not open the camera setup page (${explain(error)}).`, 'error');
  }
}

function cancelPermissionWait() {
  waitingForPermission = false;
  if (permissionTabId) chrome.tabs.remove(permissionTabId).catch(() => {});
  permissionTabId = null;
  updateControls();
  setStatusDot('');
  setMessage('Camera setup cancelled. Click Start AirSign when you are ready.', '');
}

async function handleStartError(error) {
  cleanupTrackingUI();
  starting = false;
  updateControls();
  setStatusDot('error');

  if (error && error.code === 'CAMERA_PROMPT') {
    setStatusDot('starting');
    setMessage('Your browser did not show the camera prompt here. Allow access once in the setup tab; after that, tracking will start directly in the panel.', 'warn');
    await openPermissionTab();
    return;
  }

  calibrationPending = false;
  const actions = error && Array.isArray(error.actions) ? error.actions : [];
  setMessage(`AirSign could not start: ${error && error.message ? error.message : explain(error)}`, 'error', actions);
  if (running) {
    running = false;
    updateControls();
  }
}

/* ------------------------------------------------------------------ */
/* Start / stop                                                        */
/* ------------------------------------------------------------------ */

async function start() {
  if (running || starting) return;
  waitingForPermission = false;
  permissionTabId = null;
  starting = true;
  const attempt = ++startAttempt;
  updateControls();
  setStatusDot('starting');
  setMessage('Preparing the target page…');
  setTracking('Starting…');

  try {
    const tab = await findBestTarget();
    if (!tab) {
      throw new AirSignError('No controllable page is open. Open a website, or use the built-in test page.', [
        { label: 'Open test page', onClick: openSandbox }
      ]);
    }

    await activateTarget(tab, { announce: false, throwOnError: true });
    if (attempt !== startAttempt) return;

    setMessage('Requesting camera access…');
    await openCamera();
    if (attempt !== startAttempt) {
      cleanupTrackingUI();
      return;
    }

    setTracking('Loading hand model');
    setMessage('Loading the bundled hand model…');
    landmarker = await createLandmarker();
    if (attempt !== startAttempt) {
      closeLandmarker();
      return;
    }

    engine.reset();
    engine.configure(settings);
    running = true;
    starting = false;
    lastSentHand = false;
    setBadge(true);
    updateControls();
    setStatusDot('on');
    setTracking(sitePaused ? 'Paused on this site' : 'Looking for a hand');
    setGestureChip('none');
    setHandState(false);
    const startActions = settings.calibration ? [] : [{ label: 'Calibrate pinch', onClick: beginCalibration }];
    setMessage(`Tracking locally. Switch to “${target.title}” and point your index finger to move the cursor.`, 'success', startActions);
    if (sitePaused) {
      setMessage(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site when you want gestures there.`, 'warn');
    }
    renderTarget();
    startLoop();

    const active = await getActiveTab();
    if (active && isEligible(active) && active.id !== target?.tabId) {
      await activateTarget(active, { announce: true });
    }

    if (calibrationPending) {
      calibrationPending = false;
      beginCalibration();
    }
  } catch (error) {
    if (attempt !== startAttempt) return;
    await handleStartError(error);
  }
}

function stop({ unload = false } = {}) {
  const wasBusy = running || starting || waitingForPermission;
  startAttempt += 1;
  running = false;
  starting = false;
  waitingForPermission = false;
  calibrationPending = false;

  if (permissionTabId) {
    chrome.tabs.remove(permissionTabId).catch(() => {});
    permissionTabId = null;
  }
  if (target) {
    sendStop(target);
    target.bridgeReady = false;
  }
  suspended = false;
  sitePaused = false;
  cleanupTrackingUI();
  setBadge(false);
  updateControls();
  setStatusDot('');
  renderTarget();

  if (!unload && wasBusy) {
    setMessage('AirSign stopped. The camera is off.');
  }
}

/* ------------------------------------------------------------------ */
/* Camera bubble                                                       */
/* ------------------------------------------------------------------ */

function resetAfterBubble(message) {
  bubbleActive = false;
  startAttempt += 1;
  running = false;
  starting = false;
  waitingForPermission = false;
  calibrationPending = false;
  suspended = false;
  sitePaused = false;
  cleanupTrackingUI();
  setBadge(false);
  updateControls();
  setStatusDot('');
  renderTarget();
  setMessage(message, '');
}

async function minimizeToBubble() {
  if (!running || bubbleActive || starting) return;
  if (calibration) {
    setMessage('Finish or cancel pinch calibration before minimizing to the bubble.', 'warn');
    return;
  }
  if (!target) {
    setMessage('Open a regular webpage before minimizing to the camera bubble.', 'warn');
    return;
  }
  if (sitePaused) {
    setMessage(`AirSign is paused on ${siteHost(target)}. Resume on this site before minimizing to the camera bubble.`, 'warn');
    return;
  }
  if (suspended) {
    setMessage('Open a regular webpage before minimizing to the camera bubble.', 'warn');
    return;
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(target.tabId);
  } catch (_) {}
  if (!tab || !isEligible(tab)) {
    setMessage('The target page is no longer available. Pick another page and try again.', 'error');
    return;
  }

  bubbleBtn.disabled = true;
  setMessage('Moving hand tracking into the camera bubble…');

  startAttempt += 1;
  running = false;
  starting = false;
  waitingForPermission = false;
  calibrationPending = false;
  sendStop(target);
  if (target) target.bridgeReady = false;
  suspended = false;
  cleanupTrackingUI();
  updateControls();
  renderTarget();

  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({
      type: 'AIRSIGN_ENTER_BUBBLE',
      tab: { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title },
      settings: { ...settings }
    });
  } catch (error) {
    reply = { ok: false, error: explain(error) };
  }

  if (!reply || !reply.ok) {
    setMessage(`Could not minimize to the camera bubble${reply && reply.error ? `: ${reply.error}` : ''}. Restarting in the panel…`, 'error');
    start();
    return;
  }

  bubbleActive = true;
  currentWindowId = Number.isInteger(tab.windowId) ? tab.windowId : currentWindowId;
  setStatusDot('on');
  setTracking('In camera bubble');
  setMessage('Tracking moved to the camera bubble on the page. Drag it anywhere. Close this panel for more room; use Panel in the bubble to bring it back.', 'success');
  updateControls();
  renderTarget();
  window.close();
}

async function stopBubbleFromPanel() {
  stopBtn.disabled = true;
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'AIRSIGN_PANEL_STOP_BUBBLE' });
  } catch (_) {}
  if (bubbleActive) {
    resetAfterBubble(reply && reply.ok === false ? 'Could not stop the camera bubble. Try again.' : 'AirSign stopped. The camera is off.');
  }
}

function restoreFromBubble() {
  if (bubbleActive) resetAfterBubble('');
  setMessage('Camera restored from the bubble. Starting tracking in the panel…', 'success');
  start();
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' }).catch(() => {});
  if (on) {
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Sandbox                                                             */
/* ------------------------------------------------------------------ */

async function openSandbox() {
  try {
    const url = sandboxUrl();
    let tab = null;
    const existing = await chrome.tabs.query({ url }).catch(() => []);
    if (existing && existing[0]) {
      tab = await chrome.tabs.update(existing[0].id, { active: true });
    } else {
      tab = await chrome.tabs.create({ url });
    }

    if (running && tab) {
      await activateTarget(tab, { announce: false });
      if (target?.bridgeReady) {
        setMessage('Test page ready. Point at the buttons, pinch to click, and use a fist on the slider.', 'success');
      }
    } else {
      previewTab = tab;
      renderTarget();
      setMessage('Test page opened. Click Start AirSign to try every gesture in a safe place.', '');
    }
  } catch (error) {
    setMessage(`Could not open the test page: ${explain(error)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

startBtn.addEventListener('click', () => {
  start();
});

stopBtn.addEventListener('click', () => {
  if (bubbleActive) {
    stopBubbleFromPanel();
    return;
  }
  if (waitingForPermission) {
    cancelPermissionWait();
    return;
  }
  stop();
});

bubbleBtn.addEventListener('click', minimizeToBubble);

sandboxBtn.addEventListener('click', openSandbox);

sitePauseBtn.addEventListener('click', toggleSitePause);

for (const button of reachButtons) {
  button.addEventListener('click', () => changeSettings({ reach: button.dataset.reach }));
}

smoothingInput.addEventListener('input', () => {
  changeSettings({ smoothing: clamp(Number(smoothingInput.value), 0, 100) });
});

mirrorInput.addEventListener('change', () => {
  changeSettings({ mirror: mirrorInput.checked });
});

assistInput.addEventListener('change', () => {
  changeSettings({ assist: assistInput.checked });
});

dwellInput.addEventListener('change', () => {
  changeSettings({ dwell: dwellInput.checked });
});

dwellMsInput.addEventListener('input', () => {
  changeSettings({ dwellMs: normalizeDwellMs(dwellMsInput.value) });
});

calibrateBtn.addEventListener('click', beginCalibration);

resetCalibrationBtn.addEventListener('click', () => {
  if (calibration) return;
  changeSettings({ calibration: null });
  setMessage('Pinch calibration reset. AirSign is using the default thresholds.', '');
});

calibrationRetry.addEventListener('click', retryCalibration);

calibrationCancel.addEventListener('click', () => {
  if (!calibration) return;
  if (calibration.step === 'success') {
    closeCalibration('Pinch calibrated. Point at the page to keep browsing.', 'success');
  } else {
    closeCalibration('Calibration cancelled. Your previous pinch settings are unchanged.', '');
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (currentWindowId !== null && windowId !== currentWindowId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  if (!running) {
    await updatePreview(tab);
    return;
  }

  if (!isEligible(tab)) {
    if (!suspended) {
      await suspendTracking('AirSign is paused on browser pages and settings. Switch back to a normal webpage.');
    }
    return;
  }

  if (target && tab.id === target.tabId) {
    if (isPausedSite(tab)) {
      if (!sitePaused) {
        await suspendTracking(`AirSign is paused on ${siteHost(tab)}. Choose Resume on this site to take control back.`, { site: true });
      }
      return;
    }
    if (suspended) await resumeTracking(tab);
    return;
  }
  await activateTarget(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!running) {
    if (previewTab && tabId === previewTab.id && (changeInfo.title || changeInfo.status === 'complete')) {
      previewTab = tab;
      lastRenderedTargetKey = '';
      renderTarget();
    }
    return;
  }

  if (!target || tabId !== target.tabId) return;

  if (changeInfo.url && !changeInfo.status) {
    target.url = changeInfo.url;
    target.title = tab.title || target.title;
    lastRenderedTargetKey = '';
    if (isPausedSite(target) !== sitePaused) {
      if (!sitePaused) {
        await suspendTracking(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site to take control back.`, { site: true });
      } else {
        await resumeTracking(target);
      }
    } else {
      renderTarget();
    }
    return;
  }

  if (changeInfo.status === 'loading') {
    target.bridgeReady = false;
    target.url = tab.url || target.url;
    target.title = tab.title || target.title;
    lastRenderedTargetKey = '';
    if (isPausedSite(target)) {
      if (!sitePaused) {
        await suspendTracking(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site to take control back.`, { site: true });
      } else {
        renderTarget();
      }
      return;
    }
    if (!suspended) setBridge('warn', 'Loading');
    renderTarget();
    return;
  }

  if (changeInfo.status === 'complete') {
    target.url = tab.url || target.url;
    target.title = tab.title || target.title;
    lastRenderedTargetKey = '';
    if (isPausedSite(target)) {
      if (!sitePaused) {
        await suspendTracking(`AirSign is paused on ${siteHost(target)}. Choose Resume on this site to take control back.`, { site: true });
      } else {
        renderTarget();
      }
      return;
    }
    if (sitePaused) {
      await resumeTracking(target);
      return;
    }
    if (!suspended) {
      try {
        await ensureBridge(target, targetToken);
        setTracking('Looking for a hand');
      } catch (error) {
        setBridge('error', 'Reload page');
        setMessage(`AirSign can't reconnect to “${target.title}”: ${error.message}`, 'error');
      }
    }
    renderTarget();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (permissionTabId === tabId && waitingForPermission) {
    waitingForPermission = false;
    permissionTabId = null;
    updateControls();
    setStatusDot('');
    setMessage('The camera setup tab was closed before access was granted. Click Start AirSign to try again.', 'warn');
    return;
  }

  if (target && target.tabId === tabId) {
    target = null;
    suspended = false;
    lastSentHand = false;
    lastRenderedTargetKey = '';
    if (running) {
      setBridge('', 'No target');
      setTracking('Camera on · no target');
      setMessage('The controlled page was closed. Tracking stays on; switch to another webpage to control it.', 'warn');
      renderTarget();
    } else {
      renderTarget();
    }
  }

  if (previewTab && previewTab.id === tabId) {
    updatePreview(null);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'AIRSIGN_CAMERA_PERMISSION_GRANTED') {
    sendResponse({ ok: true });
    if (!waitingForPermission) return;
    waitingForPermission = false;
    permissionTabId = null;
    setMessage('Camera access granted. Starting hand tracking…', 'success');
    updateControls();
    start();
    return;
  }

  if (message.type === 'AIRSIGN_CAMERA_PERMISSION_FAILED') {
    sendResponse({ ok: true });
    if (!waitingForPermission) return;
    waitingForPermission = false;
    permissionTabId = null;
    updateControls();
    setStatusDot('error');
    setMessage(`Camera setup failed: ${message.error || 'Unknown error'}`, 'error', [
      { label: 'Camera settings', onClick: () => chrome.tabs.create({ url: 'chrome://settings/content/camera' }) }
    ]);
    return;
  }

  if (message.type === 'AIRSIGN_RESTORE_PANEL') {
    sendResponse({ ok: true });
    restoreFromBubble();
    return;
  }

  if (message.type === 'AIRSIGN_BUBBLE_STOPPED') {
    sendResponse({ ok: true });
    if (!bubbleActive) return;
    resetAfterBubble('The camera bubble stopped. Click Start AirSign to resume in the panel.');
  }
});

document.addEventListener('visibilitychange', () => {
  if (bubbleActive) return;
  if (document.visibilityState === 'hidden' && (running || starting)) {
    stop({ unload: true });
    setMessage('AirSign stopped because the side panel was hidden. Click Start to resume.', '');
  }
});

window.addEventListener('pagehide', () => {
  if (!bubbleActive) stop({ unload: true });
});

(async function init() {
  await loadSettings();
  await loadPausedSites();
  const active = await getActiveTab();
  currentWindowId = active && Number.isInteger(active.windowId) ? active.windowId : null;
  await updatePreview();
  updateControls();
  setStatusDot('');
  setTracking('Not started');
  setHandState(false);
  setGestureChip('none');
  setCameraLive(false);
  setFps(0);

  let takeover = null;
  try {
    takeover = await chrome.runtime.sendMessage({ type: 'AIRSIGN_PANEL_TAKEOVER', windowId: currentWindowId });
  } catch (_) {}
  if (takeover && takeover.restore) {
    setMessage('Camera restored from the bubble. Starting tracking in the panel…', 'success');
    start();
  } else if (takeover && takeover.activeElsewhere) {
    setMessage('AirSign is running in a camera bubble in another browser window.', '');
  }
})();
