import {
  createGestureEngine,
  DWELL_DEFAULT_MS,
  HAND_CONNECTIONS,
  normalizeDwellMs,
  POSE_LABELS,
  REACH_PRESETS
} from './lib/gestures.js';

const VERSION = '2.5.1';
const SETTINGS_KEY = 'airsign.demo.settings.v1';
const BUBBLE_KEY = 'airsign.demo.bubble.v1';

const DEFAULT_SETTINGS = { assist: true, reach: 'balanced', smoothing: 35, dwell: false, dwellMs: DWELL_DEFAULT_MS };

const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 5.2c0-.7.8-1.2 1.4-.8l9.2 6.8c.5.4.5 1.2 0 1.6l-9.2 6.8c-.6.4-1.4 0-1.4-.8V5.2Z"/></svg>';

const $ = (id) => document.getElementById(id);

const bridge = window.__airsignBridge || null;

const lab = $('lab');
const labStatus = $('labStatus');
const poseReadout = $('poseReadout');
const fpsReadout = $('fpsReadout');
const startLayer = $('startLayer');
const startBtn = $('startBtn');
const startBtnLabel = $('startBtnLabel');
const startError = $('startError');
const loadNote = $('loadNote');
const pauseBtn = $('pauseBtn');
const stopBtn = $('stopBtn');

const clickTarget = $('clickTarget');
const clickCount = $('clickCount');
const lightToggle = $('lightToggle');
const lightState = $('lightState');
const slider = $('slider');
const sliderFill = $('sliderFill');
const sliderThumb = $('sliderThumb');
const sliderValue = $('sliderValue');
const dragStage = $('dragStage');
const noteCard = $('noteCard');
const assistToggle = $('assistToggle');
const assistState = $('assistState');
const dwellToggle = $('dwellToggle');
const dwellState = $('dwellState');
const dwellMsInput = $('dwellMs');
const dwellValue = $('dwellValue');
const reachGroup = $('reachGroup');
const smoothingInput = $('smoothing');
const smoothingValue = $('smoothingValue');

const bubble = $('cameraBubble');
const bubbleHandle = $('bubbleHandle');
const bubbleLive = $('bubbleLive');
const bubblePause = $('bubblePause');
const bubbleStop = $('bubbleStop');
const bubbleCanvas = $('bubbleCanvas');
const bubbleMsg = $('bubbleMsg');
const bubblePose = $('bubblePose');
const bubbleFps = $('bubbleFps');

const canvasCtx = bubbleCanvas.getContext('2d');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* preferences are a convenience, not a requirement */
  }
}

function loadSettings() {
  const stored = readJSON(SETTINGS_KEY);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
  return {
    assist: typeof stored.assist === 'boolean' ? stored.assist : DEFAULT_SETTINGS.assist,
    reach: typeof stored.reach === 'string' && Object.prototype.hasOwnProperty.call(REACH_PRESETS, stored.reach)
      ? stored.reach
      : DEFAULT_SETTINGS.reach,
    smoothing: Number.isFinite(Number(stored.smoothing))
      ? clamp(Number(stored.smoothing), 0, 100)
      : DEFAULT_SETTINGS.smoothing,
    dwell: stored.dwell === true,
    dwellMs: normalizeDwellMs(stored.dwellMs)
  };
}

function loadBubblePosition() {
  const stored = readJSON(BUBBLE_KEY);
  if (!stored || !Number.isFinite(stored.rx) || !Number.isFinite(stored.ry)) return null;
  return { rx: clamp(stored.rx, 0, 1), ry: clamp(stored.ry, 0, 1) };
}

const settings = loadSettings();
const engine = createGestureEngine({
  reach: settings.reach,
  smoothing: settings.smoothing,
  mirror: true
});

const state = {
  stream: null,
  landmarker: null,
  running: false,
  starting: false,
  paused: false,
  manual: false,
  raf: 0,
  lastDetect: 0,
  lastVideoTime: -1,
  detectCount: 0,
  fpsWindowStart: 0,
  fps: 0,
  landmarks: null,
  pose: 'none',
  startToken: 0,
  bubblePos: loadBubblePosition()
};

const video = document.createElement('video');
video.muted = true;
video.autoplay = true;
video.playsInline = true;
video.setAttribute('playsinline', '');
video.setAttribute('aria-hidden', 'true');
video.style.cssText = 'position:fixed;left:-2px;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;';
document.body.appendChild(video);

let landmarkerPromise = null;
let sliderPercent = 50;
let sliderDragging = false;
let noteDrag = null;
let bubbleDrag = null;
let clicks = 0;

/* ------------------------------------------------------------------ */
/* Camera + on-device tracking                                         */
/* ------------------------------------------------------------------ */

class DemoSetupError extends Error {}

function describeCameraError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was blocked. Allow camera access from the icon in your browser’s address bar, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Connect a webcam and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is busy in another app. Close the other app (or tab) using it and try again.';
  }
  if (name === 'OverconstrainedError') {
    return 'The camera could not provide a suitable video feed. Try again, or use a different camera.';
  }
  return 'The camera could not start. Check your device and browser permissions, then try again.';
}

async function loadLandmarker() {
  if (state.landmarker) return state.landmarker;
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('./vendor/vision_bundle.js');
      const wasmPath = new URL('./vendor/wasm', import.meta.url).href;
      const modelPath = new URL('./vendor/hand_landmarker.task', import.meta.url).href;
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmPath);

      const options = {
        baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6
      };

      try {
        return await vision.HandLandmarker.createFromOptions(fileset, options);
      } catch (gpuError) {
        console.warn('[AirSign demo] GPU delegate unavailable, retrying on CPU.', gpuError);
        options.baseOptions = { modelAssetPath: modelPath, delegate: 'CPU' };
        return await vision.HandLandmarker.createFromOptions(fileset, options);
      }
    })().catch((error) => {
      landmarkerPromise = null;
      throw error;
    });
  }
  return landmarkerPromise;
}

function waitForVideo() {
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', finish);
      video.removeEventListener('playing', finish);
      resolve();
    };
    const timer = setTimeout(finish, 2500);
    video.addEventListener('loadeddata', finish, { once: true });
    video.addEventListener('playing', finish, { once: true });
  });
}

function startDemo() {
  if (state.running || state.starting) return;
  if (!bridge) {
    showStartError('The AirSign page bridge did not load. Refresh the page to try again.');
    return;
  }

  const token = ++state.startToken;
  state.starting = true;
  state.paused = false;
  state.manual = false;

  clearStartError();
  setStartBusy(true, 'Requesting camera…');
  lab.classList.remove('is-live', 'is-paused');
  lab.classList.add('is-starting');
  labStatus.textContent = 'Requesting camera…';
  pauseBtn.hidden = true;
  stopBtn.hidden = true;
  setPauseButton(false);

  (async () => {
    let stream = null;
    try {
      if (!window.isSecureContext) {
        throw new DemoSetupError('Camera access needs a secure page. Open this site over HTTPS or on localhost.');
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new DemoSetupError('This browser does not expose a camera API. Try a current version of Chrome, Edge or Firefox.');
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 }
          }
        });
      } catch (error) {
        throw new DemoSetupError(describeCameraError(error));
      }

      if (token !== state.startToken) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      state.stream = stream;
      video.srcObject = stream;

      try {
        await video.play();
      } catch (_) {
        /* muted inline video usually autoplays; drawing will retry on the next frame */
      }
      await waitForVideo();

      if (token !== state.startToken) return;

      showBubble();
      setBubbleState('starting');
      showBubbleMessage('Loading the on-device hand model…');
      setStartBusy(true, 'Loading hand model…');
      loadNote.hidden = false;
      labStatus.textContent = 'Loading hand tracking…';
      startRenderLoop();

      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (state.stream !== stream) return;
          stopDemo();
          showStartError('The camera stopped unexpectedly. Check your device and try again.');
          setStartBusy(false, 'Try again');
        });
      }

      let landmarker;
      try {
        landmarker = await loadLandmarker();
      } catch (error) {
        throw new DemoSetupError('The hand-tracking model could not load. Check your connection and try again.');
      }

      if (token !== state.startToken) return;

      state.landmarker = landmarker;
      state.running = true;
      state.starting = false;
      state.paused = false;
      state.manual = false;
      state.lastDetect = 0;
      state.lastVideoTime = -1;
      state.detectCount = 0;
      state.fpsWindowStart = performance.now();
      state.fps = 0;
      state.landmarks = null;
      engine.reset();

      lab.classList.remove('is-starting');
      lab.classList.add('is-live');
      labStatus.textContent = 'Camera live · tracking locally';
      pauseBtn.hidden = false;
      stopBtn.hidden = false;
      setStartBusy(false, 'Start camera');
      setPauseButton(false);
      hideBubbleMessage();
      setBubbleState('live');
      setFpsUI(0);
      updatePoseUI('none', false);
      loadNote.hidden = true;

      if (!video.videoWidth) {
        showBubbleMessage('Warming up the camera…');
        setTimeout(() => {
          if (state.running && !state.paused) hideBubbleMessage();
        }, 1200);
      }
    } catch (error) {
      if (token !== state.startToken) return;
      state.running = false;
      state.starting = false;
      state.paused = false;
      releaseStream();
      stopRenderLoop();
      hideBubble();
      lab.classList.remove('is-live', 'is-starting', 'is-paused');
      labStatus.textContent = 'Camera off';
      setStartBusy(false, 'Try again');
      setFpsUI(0);
      updatePoseUI('none', false);
      poseReadout.textContent = '—';
      pauseBtn.hidden = true;
      stopBtn.hidden = true;
      loadNote.hidden = true;
      setBubbleState('off');
      showStartError(error instanceof DemoSetupError
        ? error.message
        : 'Something went wrong starting the camera. Please try again.');
      if (!(error instanceof DemoSetupError)) console.error('[AirSign demo] start failed', error);
    }
  })();
}

function stopDemo() {
  state.startToken += 1;
  state.running = false;
  state.starting = false;
  state.paused = false;
  state.manual = false;
  state.landmarks = null;
  state.pose = 'none';

  stopRenderLoop();
  releaseStream();
  if (bridge) bridge.stop();
  hideBubble();
  engine.reset();

  lab.classList.remove('is-live', 'is-starting', 'is-paused');
  labStatus.textContent = 'Camera off';
  poseReadout.textContent = '—';
  setFpsUI(0);
  setPauseButton(false);
  pauseBtn.hidden = true;
  stopBtn.hidden = true;
  setStartBusy(false, 'Start camera');
  loadNote.hidden = true;
  clearStartError();
  setBubbleState('off');
  bubblePose.textContent = 'No hand';
  bubble.dataset.pose = 'none';
}

function pauseDemo() {
  if (!state.running || state.paused) return;
  state.paused = true;
  state.landmarks = null;
  engine.reset();
  if (bridge) bridge.stop();
  lab.classList.add('is-paused');
  labStatus.textContent = 'Paused · camera still on';
  setPauseButton(true);
  setBubbleState('paused');
  showBubbleMessage('Tracking paused');
  updatePoseUI('none', false);
  poseReadout.textContent = 'Paused';
  bubblePose.textContent = 'Paused';
  bubble.dataset.pose = 'none';
}

function resumeDemo() {
  if (!state.running || !state.paused) return;
  state.paused = false;
  state.manual = false;
  state.lastDetect = 0;
  state.lastVideoTime = -1;
  state.detectCount = 0;
  state.fpsWindowStart = performance.now();
  state.fps = 0;
  state.landmarks = null;
  engine.reset();
  lab.classList.remove('is-paused');
  labStatus.textContent = 'Camera live · tracking locally';
  setPauseButton(false);
  setBubbleState('live');
  hideBubbleMessage();
  setFpsUI(0);
  updatePoseUI('none', false);
}

function releaseStream() {
  const stream = state.stream;
  state.stream = null;
  if (stream) {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch (_) {}
    }
  }
  try { video.pause(); } catch (_) {}
  video.srcObject = null;
  state.lastVideoTime = -1;
}

function startRenderLoop() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
  if (!state.raf) return;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
}

function renderLoop(now) {
  state.raf = 0;
  if (!state.stream) return;
  drawPreview();

  if (state.running && !state.paused && !state.manual && state.landmarker) {
    if (now - state.lastDetect >= 32) detectFrame(now);
  }

  state.raf = requestAnimationFrame(renderLoop);
}

function detectFrame(now) {
  if (video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  state.lastDetect = now;

  try {
    const result = state.landmarker.detectForVideo(video, now);
    const hand = result && result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
    const frame = engine.update(hand, now);
    state.landmarks = hand;
    state.pose = frame.pose;

    if (bridge) {
      bridge.handleFrame({
        handPresent: frame.handPresent,
        pose: frame.pose,
        x: frame.x,
        y: frame.y,
        palmX: frame.palmX,
        palmY: frame.palmY,
        scrollY: frame.scrollY,
        pinchRatio: frame.pinchRatio,
        assist: settings.assist,
        dwellMs: settings.dwell ? settings.dwellMs : 0,
        at: frame.at
      });
    }

    updatePoseUI(frame.pose, frame.handPresent);
    countInference(now);
  } catch (error) {
    console.warn('[AirSign demo] hand detection failed', error);
  }
}

function countInference(now) {
  state.detectCount += 1;
  const elapsed = now - state.fpsWindowStart;
  if (elapsed < 700) return;
  state.fps = (state.detectCount * 1000) / elapsed;
  state.detectCount = 0;
  state.fpsWindowStart = now;
  setFpsUI(state.fps);
}

function updatePoseUI(pose, handPresent) {
  const present = Boolean(handPresent) && pose !== 'none';
  const label = present ? (POSE_LABELS[pose] || 'Tracking') : 'No hand';
  poseReadout.textContent = present ? label : (state.running ? 'No hand' : '—');
  bubblePose.textContent = label;
  bubble.dataset.pose = present ? pose : 'none';
}

function setFpsUI(fps) {
  if (!fps || !Number.isFinite(fps)) {
    fpsReadout.textContent = '—';
    bubbleFps.textContent = '— FPS';
    return;
  }
  const text = `${Math.round(fps)} fps`;
  fpsReadout.textContent = text;
  bubbleFps.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Preview canvas                                                      */
/* ------------------------------------------------------------------ */

function drawPreview() {
  const width = bubbleCanvas.width;
  const height = bubbleCanvas.height;
  canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
  canvasCtx.fillStyle = '#05080e';
  canvasCtx.fillRect(0, 0, width, height);

  if (!video.videoWidth || !video.videoHeight) return;

  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  canvasCtx.save();
  canvasCtx.translate(width, 0);
  canvasCtx.scale(-1, 1);
  canvasCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
  if (state.landmarks) drawSkeleton(state.landmarks, offsetX, offsetY, drawWidth, drawHeight);
  canvasCtx.restore();

  const vignette = canvasCtx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.24,
    width / 2, height / 2, Math.max(width, height) * 0.72
  );
  vignette.addColorStop(0, 'rgba(2, 5, 10, 0)');
  vignette.addColorStop(1, 'rgba(2, 5, 10, 0.52)');
  canvasCtx.fillStyle = vignette;
  canvasCtx.fillRect(0, 0, width, height);
}

function drawSkeleton(landmarks, offsetX, offsetY, drawWidth, drawHeight) {
  const x = (point) => offsetX + point.x * drawWidth;
  const y = (point) => offsetY + point.y * drawHeight;

  canvasCtx.save();
  canvasCtx.lineWidth = 2.6;
  canvasCtx.strokeStyle = 'rgba(94, 234, 212, 0.82)';
  canvasCtx.shadowColor = 'rgba(34, 211, 238, 0.8)';
  canvasCtx.shadowBlur = 8;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  canvasCtx.beginPath();
  for (const [start, end] of HAND_CONNECTIONS) {
    canvasCtx.moveTo(x(landmarks[start]), y(landmarks[start]));
    canvasCtx.lineTo(x(landmarks[end]), y(landmarks[end]));
  }
  canvasCtx.stroke();

  canvasCtx.shadowBlur = 0;
  for (let index = 0; index < landmarks.length; index += 1) {
    const point = landmarks[index];
    const isTip = index === 8;
    canvasCtx.beginPath();
    canvasCtx.arc(x(point), y(point), isTip ? 4.2 : 2.5, 0, Math.PI * 2);
    canvasCtx.fillStyle = isTip ? '#b9fdff' : 'rgba(228, 255, 255, 0.9)';
    canvasCtx.fill();
  }

  if (state.pose === 'point' || state.pose === 'click') {
    const tip = landmarks[8];
    canvasCtx.beginPath();
    canvasCtx.arc(x(tip), y(tip), 11, 0, Math.PI * 2);
    canvasCtx.strokeStyle = state.pose === 'click' ? 'rgba(52, 211, 153, 0.7)' : 'rgba(34, 211, 238, 0.55)';
    canvasCtx.lineWidth = 1.4;
    canvasCtx.stroke();
  }
  canvasCtx.restore();
}

/* ------------------------------------------------------------------ */
/* Camera bubble                                                       */
/* ------------------------------------------------------------------ */

function showBubble() {
  bubble.hidden = false;
  bubblePose.textContent = 'No hand';
  bubble.dataset.pose = 'none';
  setFpsUI(0);
  positionBubble();
}

function hideBubble() {
  bubble.hidden = true;
  bubble.classList.remove('dragging');
  bubbleDrag = null;
  hideBubbleMessage();
}

function setBubbleState(kind) {
  bubble.dataset.state = kind;
  const labels = { starting: 'Starting', live: 'Live', paused: 'Paused', off: 'Off' };
  bubbleLive.innerHTML = `<i></i> ${labels[kind] || 'Starting'}`;
}

function showBubbleMessage(text, isError = false) {
  bubbleMsg.hidden = false;
  bubbleMsg.textContent = text;
  bubbleMsg.classList.toggle('is-error', isError);
}

function hideBubbleMessage() {
  bubbleMsg.hidden = true;
  bubbleMsg.classList.remove('is-error');
}

function bubbleMargin() {
  return window.matchMedia('(max-width: 720px)').matches ? 12 : 22;
}

function positionBubble() {
  if (bubble.hidden) return;
  const margin = bubbleMargin();
  const width = bubble.offsetWidth || 264;
  const height = bubble.offsetHeight || 230;
  const freeX = Math.max(1, innerWidth - width - margin * 2);
  const freeY = Math.max(1, innerHeight - height - margin * 2);
  const rx = state.bubblePos ? state.bubblePos.rx : 1;
  const ry = state.bubblePos ? state.bubblePos.ry : 1;
  const left = clamp(margin + rx * freeX, margin, margin + freeX);
  const top = clamp(margin + ry * freeY, margin, margin + freeY);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.right = 'auto';
  bubble.style.bottom = 'auto';
}

function moveBubble(left, top) {
  const margin = 8;
  const width = bubble.offsetWidth || 264;
  const height = bubble.offsetHeight || 230;
  const nextLeft = clamp(left, margin, Math.max(margin, innerWidth - width - margin));
  const nextTop = clamp(top, margin, Math.max(margin, innerHeight - height - margin));
  bubble.style.left = `${nextLeft}px`;
  bubble.style.top = `${nextTop}px`;
  bubble.style.right = 'auto';
  bubble.style.bottom = 'auto';
}

function saveBubblePosition() {
  const margin = bubbleMargin();
  const width = bubble.offsetWidth || 264;
  const height = bubble.offsetHeight || 230;
  const freeX = Math.max(1, innerWidth - width - margin * 2);
  const freeY = Math.max(1, innerHeight - height - margin * 2);
  const rect = bubble.getBoundingClientRect();
  state.bubblePos = {
    rx: clamp((rect.left - margin) / freeX, 0, 1),
    ry: clamp((rect.top - margin) / freeY, 0, 1)
  };
  writeJSON(BUBBLE_KEY, state.bubblePos);
}

bubbleHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = bubble.getBoundingClientRect();
  bubbleDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };
  bubble.classList.add('dragging');
  event.preventDefault();
});

window.addEventListener('pointermove', (event) => {
  if (bubbleDrag && event.pointerId === bubbleDrag.pointerId) {
    moveBubble(event.clientX - bubbleDrag.offsetX, event.clientY - bubbleDrag.offsetY);
  }
  if (sliderDragging) setSliderFromClientX(event.clientX);
  if (noteDrag) moveNote(event.clientX, event.clientY);
});

window.addEventListener('pointerup', endPointerAction);
window.addEventListener('pointercancel', endPointerAction);

function endPointerAction(event) {
  if (bubbleDrag && (!event || event.pointerId === bubbleDrag.pointerId)) {
    bubbleDrag = null;
    bubble.classList.remove('dragging');
    saveBubblePosition();
  }
  if (sliderDragging) {
    sliderDragging = false;
    slider.classList.remove('dragging');
  }
  if (noteDrag) {
    noteDrag = null;
    noteCard.classList.remove('dragging');
  }
}

window.addEventListener('resize', () => {
  if (!bubble.hidden) positionBubble();
  clampNoteToStage();
});

/* ------------------------------------------------------------------ */
/* Practice range                                                      */
/* ------------------------------------------------------------------ */

clickTarget.addEventListener('click', () => {
  clicks += 1;
  clickCount.textContent = String(clicks);
  clickTarget.classList.remove('hit');
  void clickTarget.offsetWidth;
  clickTarget.classList.add('hit');
});

function setLamp(on) {
  lightToggle.setAttribute('aria-checked', String(on));
  lightState.textContent = on ? 'On' : 'Off';
  lab.dataset.lit = String(on);
}

lightToggle.addEventListener('click', () => {
  setLamp(lightToggle.getAttribute('aria-checked') !== 'true');
});

function setSlider(value) {
  sliderPercent = clamp(Math.round(value), 0, 100);
  sliderFill.style.width = `${sliderPercent}%`;
  sliderThumb.style.left = `${sliderPercent}%`;
  sliderValue.textContent = `${sliderPercent}%`;
  slider.setAttribute('aria-valuenow', String(sliderPercent));
  lab.style.setProperty('--room', String(sliderPercent / 100));
}

function setSliderFromClientX(clientX) {
  const rect = slider.getBoundingClientRect();
  if (!rect.width) return;
  setSlider(((clientX - rect.left) / rect.width) * 100);
}

slider.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  sliderDragging = true;
  slider.classList.add('dragging');
  setSliderFromClientX(event.clientX);
  event.preventDefault();
});

slider.addEventListener('keydown', (event) => {
  const delta = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[event.key];
  if (delta) {
    setSlider(sliderPercent + delta);
    event.preventDefault();
  } else if (event.key === 'Home') {
    setSlider(0);
    event.preventDefault();
  } else if (event.key === 'End') {
    setSlider(100);
    event.preventDefault();
  }
});

noteCard.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const rect = noteCard.getBoundingClientRect();
  noteDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };
  noteCard.classList.add('dragging');
  event.preventDefault();
});

function moveNote(clientX, clientY) {
  if (!noteDrag) return;
  const rect = dragStage.getBoundingClientRect();
  const maxLeft = Math.max(0, rect.width - noteDrag.width);
  const maxTop = Math.max(0, rect.height - noteDrag.height);
  const left = clamp(clientX - rect.left - noteDrag.offsetX, 0, maxLeft);
  const top = clamp(clientY - rect.top - noteDrag.offsetY, 0, maxTop);
  noteCard.style.left = `${left}px`;
  noteCard.style.top = `${top}px`;
}

function clampNoteToStage() {
  if (!noteCard.style.left) return;
  const rect = dragStage.getBoundingClientRect();
  const card = noteCard.getBoundingClientRect();
  const left = Math.max(0, Math.min(parseFloat(noteCard.style.left) || 0, rect.width - card.width));
  const top = Math.max(0, Math.min(parseFloat(noteCard.style.top) || 0, rect.height - card.height));
  noteCard.style.left = `${left}px`;
  noteCard.style.top = `${top}px`;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

function saveSettings() {
  writeJSON(SETTINGS_KEY, settings);
}

function setAssist(on, persist = true) {
  settings.assist = Boolean(on);
  assistToggle.setAttribute('aria-checked', String(settings.assist));
  assistState.textContent = settings.assist ? 'On · forgiving aim' : 'Off · exact aim';
  if (persist) saveSettings();
}

assistToggle.addEventListener('click', () => {
  setAssist(!settings.assist);
});

function setDwell(on, persist = true) {
  settings.dwell = Boolean(on);
  dwellToggle.setAttribute('aria-checked', String(settings.dwell));
  dwellState.textContent = settings.dwell ? 'On · hold to click' : 'Off · pinch only';
  if (persist) saveSettings();
}

dwellToggle.addEventListener('click', () => {
  setDwell(!settings.dwell);
});

dwellMsInput.addEventListener('input', () => {
  settings.dwellMs = normalizeDwellMs(dwellMsInput.value);
  dwellValue.textContent = `${settings.dwellMs} ms`;
  saveSettings();
});

function setReach(reach, persist = true) {
  if (!Object.prototype.hasOwnProperty.call(REACH_PRESETS, reach)) return;
  settings.reach = reach;
  engine.configure({ reach });
  for (const button of reachGroup.querySelectorAll('button')) {
    const active = button.dataset.reach === reach;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (persist) saveSettings();
}

for (const button of reachGroup.querySelectorAll('button')) {
  button.addEventListener('click', () => setReach(button.dataset.reach));
}

smoothingInput.addEventListener('input', () => {
  const value = clamp(Number(smoothingInput.value) || 0, 0, 100);
  settings.smoothing = value;
  smoothingValue.textContent = String(Math.round(value));
  engine.configure({ smoothing: value });
  saveSettings();
});

function syncSettingsUI() {
  setAssist(settings.assist, false);
  setDwell(settings.dwell, false);
  setReach(settings.reach, false);
  smoothingInput.value = String(settings.smoothing);
  smoothingValue.textContent = String(Math.round(settings.smoothing));
  dwellMsInput.value = String(settings.dwellMs);
  dwellValue.textContent = `${settings.dwellMs} ms`;
}

/* ------------------------------------------------------------------ */
/* Chrome / UI helpers                                                 */
/* ------------------------------------------------------------------ */

function setStartBusy(busy, label) {
  startBtn.classList.toggle('is-busy', busy);
  startBtn.disabled = busy;
  if (label) startBtnLabel.textContent = label;
}

function showStartError(message) {
  startError.hidden = false;
  startError.textContent = message;
}

function clearStartError() {
  startError.hidden = true;
  startError.textContent = '';
}

function setPauseButton(paused) {
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  bubblePause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  bubblePause.setAttribute('aria-label', paused ? 'Resume tracking' : 'Pause tracking');
  bubblePause.title = paused ? 'Resume tracking' : 'Pause tracking';
}

startBtn.addEventListener('click', startDemo);
pauseBtn.addEventListener('click', () => (state.paused ? resumeDemo() : pauseDemo()));
stopBtn.addEventListener('click', stopDemo);
bubblePause.addEventListener('click', () => (state.paused ? resumeDemo() : pauseDemo()));
bubbleStop.addEventListener('click', stopDemo);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (state.running || state.starting)) {
    stopDemo();
  }
});

window.addEventListener('pagehide', () => {
  state.stream && state.stream.getTracks().forEach((track) => track.stop());
  stopRenderLoop();
  if (bridge) bridge.stop();
});

/* Initial UI ------------------------------------------------------------- */

syncSettingsUI();
setSlider(50);
setLamp(false);
setPauseButton(false);
setStartBusy(false, 'Start camera');
setFpsUI(0);
updatePoseUI('none', false);
poseReadout.textContent = '—';
startError.hidden = true;
setBubbleState('off');

if (!bridge) {
  showStartError('The AirSign page bridge did not load. Refresh the page to try again.');
  startBtn.disabled = true;
  startBtnLabel.textContent = 'Page bridge missing';
}

/* ------------------------------------------------------------------ */
/* Test hook — used by the repository smoke test, not by the UI         */
/* ------------------------------------------------------------------ */

window.__airsignDemo = {
  version: VERSION,
  get state() {
    return {
      running: state.running,
      starting: state.starting,
      paused: state.paused,
      manual: state.manual,
      pose: state.pose,
      fps: Math.round(state.fps || 0),
      hasStream: Boolean(state.stream),
      hasModel: Boolean(state.landmarker),
      clicks,
      settings: { ...settings }
    };
  },
  start: startDemo,
  stop: stopDemo,
  pause: pauseDemo,
  resume: resumeDemo,
  setManual(enabled) {
    state.manual = Boolean(enabled);
    state.lastDetect = 0;
  },
  injectFrame(frame = {}) {
    if (!bridge) return false;
    const x = clamp(Number.isFinite(Number(frame.x)) ? Number(frame.x) : 0.5, 0, 1);
    const y = clamp(Number.isFinite(Number(frame.y)) ? Number(frame.y) : 0.5, 0, 1);
    const handPresent = frame.handPresent !== false && frame.pose !== 'none';
    const payload = {
      handPresent,
      pose: handPresent ? (frame.pose || 'point') : 'none',
      x,
      y,
      palmX: Number.isFinite(Number(frame.palmX)) ? Number(frame.palmX) : x,
      palmY: Number.isFinite(Number(frame.palmY)) ? Number(frame.palmY) : y,
      scrollY: Number.isFinite(Number(frame.scrollY)) ? Number(frame.scrollY) : 0.5,
      assist: settings.assist,
      dwellMs: settings.dwell ? settings.dwellMs : 0,
      at: performance.now()
    };
    state.pose = payload.pose;
    bridge.handleFrame(payload);
    updatePoseUI(payload.pose, handPresent);
    return true;
  },
  get engine() {
    return engine;
  }
};
