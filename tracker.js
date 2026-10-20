'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const startBtn = $('startTracker');
const stopBtn = $('stopTracker');
const statusEl = $('status');
const cameraState = $('cameraState');
const dot = $('dot');
const placeholder = $('placeholder');
const targetInfo = $('targetInfo');
const params = new URLSearchParams(location.search);
const initialTargetTabId = Number(params.get('targetTabId'));
let targetTabId = initialTargetTabId;
let targetUrl = params.get('targetUrl') || '';
let targetTitle = params.get('targetTitle') || 'Selected webpage';
const sessionId = params.get('sessionId') || '';
let pageBridgeReady = false;
let pageBridgeFailed = false;
const CFG = { clickOn: 0.30, clickOff: 0.45, zoneX: [0.12, 0.88], zoneY: [0.08, 0.72] };
const HAND_LINES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let stream = null;
let hands = null;
let running = false;
let processing = false;
let animationId = 0;
let lastSend = 0;
let lastPanelStatus = 0;
let clickPinch = false;
let lastPose = 'none';
let startStage = 'idle';
let lastPreviewSent = 0;
const previewCanvas = document.createElement('canvas');
previewCanvas.width = 320; previewCanvas.height = 180;
const previewCtx = previewCanvas.getContext('2d', { alpha: false });

function setMessage(text, kind = '') { statusEl.textContent = text; statusEl.className = kind; }
function describeError(error) {
  if (!error) return 'Unknown error';
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error.message === 'string' && error.message ? error.message : String(error);
  const constraint = error.constraint ? ` (constraint: ${error.constraint})` : '';
  return `${name}: ${message}${constraint}`;
}
function sendPanelStatus(status, text, handDetected = false) {
  chrome.runtime.sendMessage({ type: 'AIRSIGN_TRACKER_STATUS', sessionId, status, text, handDetected }).catch(() => {});
}
function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
function fingerUp(lm,tip,pip) { return dist(lm[tip],lm[0]) > dist(lm[pip],lm[0]) * 1.02; }
function clamp01(n) { return Math.max(0,Math.min(1,n)); }
function classify(lm) {
  const handSize = dist(lm[0],lm[9]) || 1e-3;
  const pinchRatio = dist(lm[4],lm[8]) / handSize;
  if (!clickPinch && pinchRatio < CFG.clickOn) clickPinch = true;
  else if (clickPinch && pinchRatio > CFG.clickOff) clickPinch = false;
  const idx = fingerUp(lm,8,6), mid = fingerUp(lm,12,10), ring = fingerUp(lm,16,14), pinky = fingerUp(lm,20,18);
  if (!idx && !mid && !ring && !pinky) return 'drag';
  if (clickPinch) return 'click';
  if (idx && mid && !ring && !pinky) return 'scroll';
  if (idx && !mid) return 'point';
  return 'idle';
}
function mapPoint(nx,ny) {
  return { x: clamp01((nx-CFG.zoneX[0])/(CFG.zoneX[1]-CFG.zoneX[0])), y: clamp01((ny-CFG.zoneY[0])/(CFG.zoneY[1]-CFG.zoneY[0])) };
}
function drawPreview(lm) {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (!lm) return;
  ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(34,211,238,.9)';
  for (const [a,b] of HAND_LINES) { ctx.beginPath(); ctx.moveTo(lm[a].x*canvas.width,lm[a].y*canvas.height); ctx.lineTo(lm[b].x*canvas.width,lm[b].y*canvas.height); ctx.stroke(); }
  ctx.fillStyle = '#fff';
  for (const p of lm) { ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,3,0,Math.PI*2); ctx.fill(); }
}
let lastPageWarning = '';
async function sendToPage(payload) {
  if (!Number.isInteger(targetTabId) || targetTabId <= 0 || !pageBridgeReady || pageBridgeFailed) return;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'AIRSIGN_GESTURE_FRAME', sessionId,
      initialTargetTabId, payload
    });
    if (!reply || reply.ok !== true) {
      const detail = reply && reply.error ? reply.error : 'No acknowledgement from the selected webpage.';
      // Tab switches can briefly occur while a page is loading. Keep tracking
      // alive and show a single diagnostic instead of killing camera capture.
      if (detail !== lastPageWarning) {
        lastPageWarning = detail;
        setMessage(`Camera tracking is active, but page control is waiting: ${detail}`, 'error');
      }
      return;
    }
    const recovered = Boolean(lastPageWarning);
    lastPageWarning = '';
    pageBridgeReady = true;
    if (recovered && running) setMessage(`Page control connected to “${targetTitle}”. Switch to that webpage to see the cursor.`, 'success');
  } catch (error) {
    const detail = describeError(error);
    console.error('AirSign could not route a gesture frame:', detail, error);
    if (detail !== lastPageWarning) {
      lastPageWarning = detail;
      setMessage(`Camera tracking is active, but page control is waiting: ${detail}`, 'error');
    }
  }
}

function sendSidePanelPreview(now = performance.now()) {
  if (!running || !video.videoWidth || now - lastPreviewSent < 250) return;
  lastPreviewSent = now;
  try {
    // Small local thumbnail: the side panel cannot share a MediaStream with this
    // tab directly, so forward a compressed preview frame at ~4 fps.
    previewCtx.save();
    previewCtx.translate(previewCanvas.width, 0);
    previewCtx.scale(-1, 1);
    previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
    previewCtx.restore();
    if (canvas.width && canvas.height) previewCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    const dataUrl = previewCanvas.toDataURL('image/jpeg', 0.55);
    chrome.runtime.sendMessage({ type: 'AIRSIGN_PREVIEW_FRAME', sessionId, dataUrl }).catch(() => {});
  } catch (error) {
    console.debug('AirSign side-panel preview frame skipped:', describeError(error));
  }
}

function onResults(results) {
  const lm = results.multiHandLandmarks && results.multiHandLandmarks[0];
  drawPreview(lm);
  sendSidePanelPreview();
  if (!lm) {
    clickPinch = false;
    if (lastPose !== 'none') sendToPage({ handPresent:false,pose:'none' });
    if (lastPose !== 'none') sendPanelStatus('gesture','Looking for a hand',false);
    lastPose = 'none';
    return;
  }
  const pose = classify(lm);
  const point = mapPoint(1-lm[8].x,lm[8].y);
  const palm = mapPoint(1-(lm[0].x+lm[9].x)/2,(lm[0].y+lm[9].y)/2);
  const scrollY = (lm[8].y+lm[12].y)/2;
  const now = performance.now();
  if (now-lastSend >= 25) {
    lastSend = now;
    sendToPage({ handPresent:true,pose,x:point.x,y:point.y,palmX:palm.x,palmY:palm.y,scrollY,frameTime:now });
  }
  const labels = { point:'Pointing',click:'Pinch to click',drag:'Fist · drag',scroll:'Two-finger scroll',idle:'Waiting for gesture' };
  if (now-lastPanelStatus > 400) {
    lastPanelStatus = now;
    sendPanelStatus('gesture',labels[pose] || 'Tracking',true);
  }
  lastPose = pose;
}
async function verifyMediaPipeAssets() {
  const required = [
    'hands_solution_packed_assets_loader.js',
    'hands_solution_packed_assets.data',
    'hands_solution_simd_wasm_bin.data',
    'hands_solution_simd_wasm_bin.js',
    'hands_solution_simd_wasm_bin.wasm',
    'hands_solution_wasm_bin.js',
    'hands_solution_wasm_bin.wasm'
  ];
  const missing = [];
  for (const filename of required) {
    const url = chrome.runtime.getURL(`vendor/${filename}`);
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) missing.push(`${filename} (HTTP ${response.status})`);
    } catch (error) {
      missing.push(`${filename} (${describeError(error)})`);
    } finally {
      // We only need the response status here; don't buffer the multi-megabyte
      // WASM/model data files before MediaPipe loads them for real.
      if (response && response.body) response.body.cancel().catch(() => {});
    }
  }
  if (missing.length) {
    throw new Error(`Local MediaPipe files are missing or unreadable: ${missing.join(', ')}. Close AirSign, run setup.bat in the extracted extension folder, then reload AirSign from chrome://extensions.`);
  }
}

async function verifyTargetPage() {
  if (!Number.isInteger(targetTabId) || targetTabId <= 0) throw new Error('AirSign has no valid target tab. Close this tab and start again from a regular webpage.');
  const tab = await chrome.tabs.get(targetTabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('The selected target is no longer a regular webpage. Start AirSign from an http:// or https:// website.');
  targetInfo.innerHTML = '';
  const label = document.createElement('strong'); label.textContent = 'Selected webpage: ';
  const title = document.createElement('span'); title.textContent = targetTitle; title.style.fontWeight = '700';
  const url = document.createElement('div'); url.textContent = tab.url || targetUrl; url.style.color = 'var(--muted)'; url.style.fontSize = '13px'; url.style.marginTop = '4px';
  const state = document.createElement('div'); state.textContent = 'Page bridge: checking…'; state.style.marginTop = '6px'; state.style.color = 'var(--muted)'; state.id = 'pageBridgeState';
  targetInfo.append(label, title, url, state);
  let reply;
  try { reply = await chrome.tabs.sendMessage(targetTabId, { type: 'AIRSIGN_PING' }); }
  catch (error) { throw new Error(`Could not reach the selected webpage (${describeError(error)}). Reload “${targetTitle}” with Ctrl+R, then close this tracker tab and start AirSign again from that webpage.`); }
  if (!reply || reply.ok !== true || reply.version !== '1.0.8') {
    throw new Error(`The selected webpage “${targetTitle}” has an outdated or missing AirSign page bridge. Reload it with Ctrl+R, close this tracker tab, and start AirSign again from that webpage.`);
  }
  pageBridgeReady = true;
  state.textContent = 'Page bridge: connected'; state.style.color = 'var(--green)';
  startStage = 'registering active webpage routing';
  const registered = await chrome.runtime.sendMessage({
    type: 'AIRSIGN_REGISTER_TRACKER', sessionId, targetTabId: initialTargetTabId
  });
  if (!registered || registered.ok !== true || registered.version !== '1.0.8') {
    throw new Error(registered && registered.error ? registered.error : 'Could not register the tracker with the extension service worker. Reload AirSign and try again.');
  }
  targetTabId = registered.targetTabId;
  targetTitle = registered.targetTitle || targetTitle;
  targetUrl = registered.targetUrl || targetUrl;
  return tab;
}
async function startTracking() {
  if (running) return;
  pageBridgeReady = false;
  pageBridgeFailed = false;
  startBtn.disabled = true;
  startStage = 'checking selected webpage';
  setMessage('Checking the webpage AirSign will control…');
  try {
    await verifyTargetPage();
    if (typeof Hands === 'undefined') throw new Error('MediaPipe assets are missing. Run setup.bat in the extracted extension folder, then reload the extension.');
    startStage = 'requesting webcam access';
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') throw new Error('Camera API is unavailable in this context. Update Chrome and try again.');
    stream = await navigator.mediaDevices.getUserMedia({ video:{ width:{ideal:640},height:{ideal:480},facingMode:'user' },audio:false });
    startStage = 'starting video preview';
    video.srcObject = stream;
    await video.play();
    canvas.width = 640; canvas.height = 480;
    placeholder.style.display = 'none';
    cameraState.textContent = 'CAMERA LIVE'; dot.classList.add('live');
    startStage = 'checking local MediaPipe assets';
    await verifyMediaPipeAssets();
    startStage = 'loading local MediaPipe model';
    hands = new Hands({ locateFile:(file) => {
      // MediaPipe normally supplies a bare filename. Reduce any URL/path to its
      // basename so it can never accidentally produce vendor/https://... .
      const cleanName = String(file).split(/[?#]/, 1)[0].split(/[\\/]/).pop();
      return chrome.runtime.getURL(`vendor/${cleanName}`);
    }});
    hands.setOptions({ maxNumHands:1,modelComplexity:1,minDetectionConfidence:0.7,minTrackingConfidence:0.6 });
    hands.onResults(onResults);
    startStage = 'initializing MediaPipe/WASM';
    await hands.initialize();
    running = true;
    stopBtn.disabled = false;
    setMessage(`AirSign is tracking. Switch to “${targetTitle}” (${targetUrl || 'selected webpage'}) to see the cursor. The cursor appears on the currently selected normal webpage, not in this tracker tab. You can switch to another webpage while tracking. Keep this tab open.`, 'success');
    sendPanelStatus('running','Looking for a hand',false);
    runFrames();
  } catch (error) {
    const detail = describeError(error);
    console.error(`AirSign failed at stage: ${startStage}`, { name:error && error.name, message:error && error.message, constraint:error && error.constraint, stack:error && error.stack, error });
    stopTracking(false);
    startBtn.disabled = false;
    setMessage(`AirSign failed at stage “${startStage}”: ${detail}`, 'error');
    sendPanelStatus('error',`Stage: ${startStage}. ${detail}`,false);
  }
}
async function runFrames() {
  if (!running || !video.videoWidth) { if (running) animationId = requestAnimationFrame(runFrames); return; }
  if (!processing) {
    processing = true;
    try { await hands.send({ image:video }); }
    catch (error) { console.error('AirSign frame processing failed:',describeError(error)); }
    finally { processing = false; }
  }
  if (running) animationId = requestAnimationFrame(runFrames);
}
function stopTracking(sendStatus = true) {
  const wasRunning = running;
  running = false;
  cancelAnimationFrame(animationId);
  processing = false;
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  video.pause(); video.srcObject = null;
  if (hands) { try { hands.close(); } catch (_) {} hands = null; }
  ctx.clearRect(0,0,canvas.width,canvas.height);
  placeholder.style.display = 'grid';
  cameraState.textContent = 'CAMERA OFF'; dot.classList.remove('live');
  startBtn.disabled = false; stopBtn.disabled = true;
  clickPinch = false; lastPose = 'none'; lastSend = 0; pageBridgeReady = false;
  try { chrome.runtime.sendMessage({ type:'AIRSIGN_STOP_CURRENT_TARGET', sessionId }).catch(()=>{}); } catch (_) {}
  try { chrome.tabs.sendMessage(initialTargetTabId,{type:'AIRSIGN_STOP'}).catch(()=>{}); } catch (_) {}
  if (sendStatus) {
    setMessage('AirSign stopped. Your camera stream has been turned off.');
    sendPanelStatus('stopped','AirSign stopped.',false);
  }
  return wasRunning;
}
startBtn.addEventListener('click',startTracking);
stopBtn.addEventListener('click',() => stopTracking(true));
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'AIRSIGN_STOP_TRACKER' && message.sessionId === sessionId) {
    stopTracking(true);
    return;
  }
  if (message.type === 'AIRSIGN_TARGET_CHANGED' && message.sessionId === sessionId && Number.isInteger(message.targetTabId)) {
    targetTabId = message.targetTabId;
    targetTitle = message.targetTitle || 'Webpage';
    targetUrl = message.targetUrl || '';
    if (targetInfo) {
      targetInfo.innerHTML = '';
      const label = document.createElement('strong'); label.textContent = 'Current webpage: ';
      const title = document.createElement('span'); title.textContent = targetTitle;
      const url = document.createElement('div'); url.textContent = targetUrl; url.style.color = 'var(--muted)'; url.style.fontSize = '13px'; url.style.marginTop = '4px';
      const state = document.createElement('div'); state.textContent = 'Page bridge: switching…'; state.style.marginTop = '6px'; state.style.color = 'var(--muted)';
      targetInfo.append(label, title, url, state);
    }
    lastPageWarning = '';
    setMessage(`Target changed to “${targetTitle}”. Switch to that webpage; the cursor appears there, not in this tracker tab.`, 'success');
  }
});
window.addEventListener('pagehide',() => stopTracking(false));

if (targetInfo) {
  targetInfo.innerHTML = '';
  const label = document.createElement('strong'); label.textContent = 'Selected webpage: ';
  const title = document.createElement('span'); title.textContent = targetTitle;
  const url = document.createElement('div'); url.textContent = targetUrl; url.style.color = 'var(--muted)'; url.style.fontSize = '13px'; url.style.marginTop = '4px';
  targetInfo.append(label, title, url);
}
if (!sessionId || !Number.isInteger(targetTabId) || targetTabId <= 0) {
  startBtn.disabled = true;
  setMessage('This tracking tab was opened without a valid AirSign session. Close it and start AirSign from a regular webpage.', 'error');
}
