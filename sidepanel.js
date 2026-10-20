'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const messageEl = $('message');
const cameraStateEl = $('cameraState');
const statusDot = $('statusDot');
const cameraBadge = document.querySelector('.camera-badge');
const cameraPlaceholder = $('cameraPlaceholder');
const gestureStatus = $('gestureStatus');
const handStatus = $('handStatus');
const targetInfo = $('targetInfo');
const VERSION = '1.0.9';
const CFG = { clickOn:0.30, clickOff:0.45, zoneX:[0.12,0.88], zoneY:[0.08,0.72] };
const HAND_LINES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let targetTabId = null, initialTargetTabId = null, targetTitle = '', targetUrl = '';
let sessionId = null, stream = null, hands = null;
let running = false, starting = false, waitingForPermission = false, processing = false;
let animationId = 0, lastSend = 0, lastPanelStatus = 0, clickPinch = false, lastPose = 'none';
let permissionTabId = null, startStage = 'idle', lastPageWarning = '', pageBridgeReady = false, permissionBootstrapAttempted = false;

function explain(error) {
  if (!error) return 'Unknown error';
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error.message === 'string' && error.message ? error.message : String(error);
  const extra = error.constraint ? ` (constraint: ${error.constraint})` : '';
  return `${name}: ${message}${extra}`;
}
function setMessage(text, kind='') { messageEl.textContent = text; messageEl.className = `message${kind ? ` ${kind}` : ''}`; }
function setStatus(text, active=running, hand=false) {
  gestureStatus.textContent = text;
  statusDot.classList.toggle('on', active);
  cameraStateEl.textContent = active ? 'CAMERA LIVE' : 'CAMERA OFF';
  cameraBadge.classList.toggle('live', active);
  handStatus.textContent = hand ? 'HAND DETECTED' : (active ? 'NO HAND' : 'CAMERA OFF');
  handStatus.classList.toggle('detected', hand);
}
function showPlaceholder(show, text) {
  cameraPlaceholder.hidden = !show;
  if (text) cameraPlaceholder.innerHTML = text;
}
function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
function fingerUp(lm,tip,pip) { return dist(lm[tip],lm[0]) > dist(lm[pip],lm[0])*1.02; }
function clamp01(n) { return Math.max(0,Math.min(1,n)); }
function classify(lm) {
  const handSize = dist(lm[0],lm[9]) || 1e-3;
  const ratio = dist(lm[4],lm[8]) / handSize;
  if (!clickPinch && ratio < CFG.clickOn) clickPinch = true;
  else if (clickPinch && ratio > CFG.clickOff) clickPinch = false;
  const idx=fingerUp(lm,8,6), mid=fingerUp(lm,12,10), ring=fingerUp(lm,16,14), pinky=fingerUp(lm,20,18);
  if (!idx && !mid && !ring && !pinky) return 'drag';
  if (clickPinch) return 'click';
  if (idx && mid && !ring && !pinky) return 'scroll';
  if (idx && !mid) return 'point';
  return 'idle';
}
function mapPoint(nx,ny) {
  return {x:clamp01((nx-CFG.zoneX[0])/(CFG.zoneX[1]-CFG.zoneX[0])),y:clamp01((ny-CFG.zoneY[0])/(CFG.zoneY[1]-CFG.zoneY[0]))};
}
function drawLandmarks(lm) {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (!lm) return;
  ctx.lineWidth=3; ctx.strokeStyle='rgba(34,211,238,.95)';
  for (const [a,b] of HAND_LINES) { ctx.beginPath(); ctx.moveTo(lm[a].x*canvas.width,lm[a].y*canvas.height); ctx.lineTo(lm[b].x*canvas.width,lm[b].y*canvas.height); ctx.stroke(); }
  ctx.fillStyle='#fff'; for (const p of lm) { ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,3.4,0,Math.PI*2); ctx.fill(); }
}
function updateTargetInfo(bridge='checking…', kind='') {
  targetInfo.replaceChildren();
  const h = document.createElement('strong'); h.textContent = 'Target webpage: ';
  const title = document.createElement('span'); title.textContent = targetTitle || 'Not selected';
  const url = document.createElement('div'); url.textContent = targetUrl || 'Open a normal website and start AirSign.'; url.style.marginTop='4px';
  const state = document.createElement('div'); state.textContent = `Page bridge: ${bridge}`; state.style.marginTop='5px';
  if (kind) state.className = kind;
  targetInfo.append(h,title,url,state);
}
async function getActiveWebTab() {
  const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  const tab = tabs && tabs[0];
  if (!tab || !Number.isInteger(tab.id)) throw new Error('Could not identify the active webpage. Open a regular http:// or https:// website and try again.');
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('Chrome protects this page. Switch to a regular http:// or https:// website before starting AirSign.');
  return tab;
}
async function prepareTarget() {
  const tab = await getActiveWebTab();
  targetTabId = tab.id; initialTargetTabId = tab.id; targetTitle = tab.title || 'Webpage'; targetUrl = tab.url || '';
  updateTargetInfo('checking…');
  try {
    await chrome.scripting.executeScript({target:{tabId:targetTabId},files:['content.js']});
    const reply = await chrome.tabs.sendMessage(targetTabId,{type:'AIRSIGN_PING'});
    if (!reply || reply.ok !== true || reply.version !== VERSION) throw new Error('The page bridge is old or unavailable. Reload this webpage with Ctrl+R, then start AirSign again.');
  } catch (error) {
    throw new Error(`Could not connect to “${targetTitle}” (${explain(error)}). Reload that webpage with Ctrl+R, then try again.`);
  }
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const reg = await chrome.runtime.sendMessage({type:'AIRSIGN_REGISTER_TRACKER',sessionId,targetTabId:initialTargetTabId,sourceType:'sidepanel'});
  if (!reg || reg.ok !== true || reg.version !== VERSION) throw new Error(reg && reg.error ? reg.error : 'Could not register the AirSign side panel with the extension service worker.');
  targetTabId = reg.targetTabId || initialTargetTabId;
  targetTitle = reg.targetTitle || targetTitle; targetUrl = reg.targetUrl || targetUrl;
  pageBridgeReady = true; updateTargetInfo('connected','bridge-ok');
}
async function permissionState() {
  try { const status = await navigator.permissions.query({name:'camera'}); return status.state; }
  catch (_) { return 'unknown'; }
}
async function openPermissionTab() {
  if (waitingForPermission) return;
  waitingForPermission = true;
  startBtn.disabled = true;
  startBtn.innerHTML = '<span class="button-icon">…</span> Waiting for permission';
  setMessage('Chrome does not show the first camera permission prompt reliably inside a side panel. Allow camera access in the one-time setup tab; tracking will then run here.', '');
  permissionBootstrapAttempted = true;
  try {
    const tab = await chrome.tabs.create({url:chrome.runtime.getURL('permission.html'),active:true});
    permissionTabId = tab.id;
  } catch (error) {
    waitingForPermission = false;
    startBtn.disabled = false; startBtn.innerHTML = '<span class="button-icon">▶</span> Start AirSign';
    throw new Error(`Could not open Chrome's one-time camera permission page (${explain(error)}).`);
  }
}
async function verifyAssets() {
  const needed=['hands_solution_packed_assets_loader.js','hands_solution_packed_assets.data','hands_solution_simd_wasm_bin.data','hands_solution_simd_wasm_bin.js','hands_solution_simd_wasm_bin.wasm','hands_solution_wasm_bin.js','hands_solution_wasm_bin.wasm'];
  const missing=[];
  for (const name of needed) {
    try { const r=await fetch(chrome.runtime.getURL(`vendor/${name}`),{cache:'no-store'}); if(!r.ok)missing.push(`${name} (HTTP ${r.status})`); if(r.body)r.body.cancel().catch(()=>{}); }
    catch(e) { missing.push(`${name} (${explain(e)})`); }
  }
  if(missing.length) throw new Error(`Missing local MediaPipe assets: ${missing.join(', ')}. Run setup.bat from the extracted AirSign folder, then reload the extension.`);
}
async function startCameraTracking() {
  if (running || starting) return;
  starting = true; startStage='requesting webcam access';
  startBtn.disabled=true; startBtn.innerHTML='<span class="button-icon">…</span> Starting camera';
  try {
    if (typeof Hands === 'undefined') throw new Error('MediaPipe is not loaded. Run setup.bat in the extracted extension folder, then reload AirSign.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera API is unavailable in this Chrome context. Update Chrome and try again.');
    stream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'},audio:false});
    video.srcObject=stream;
    await video.play();
    canvas.width=640; canvas.height=480;
    showPlaceholder(false);
    setStatus('Loading hand model',false,false);
    startStage='checking local MediaPipe assets'; await verifyAssets();
    startStage='loading local MediaPipe model';
    hands = new Hands({locateFile:(file)=>{
      const clean=String(file).split(/[?#]/,1)[0].split(/[\\/]/).pop();
      return chrome.runtime.getURL(`vendor/${clean}`);
    }});
    hands.setOptions({maxNumHands:1,modelComplexity:1,minDetectionConfidence:0.7,minTrackingConfidence:0.6});
    hands.onResults(onResults);
    startStage='initializing MediaPipe/WASM'; await hands.initialize();
    running=true; starting=false; startBtn.disabled=true; startBtn.innerHTML='<span class="button-icon">●</span> AirSign running'; stopBtn.disabled=false;
    setStatus('Looking for a hand',true,false);
    setMessage('AirSign is running in this side panel. Switch to the selected webpage and point your index finger to move the cursor.', 'success');
    updateTargetInfo('connected','bridge-ok');
    runFrames();
  } catch(error) {
    const detail=explain(error);
    console.error(`AirSign failed at stage “${startStage}”: ${detail}`, {name:error&&error.name,message:error&&error.message,stack:error&&error.stack,error});
    cleanupMedia(false); starting=false; startBtn.disabled=false; startBtn.innerHTML='<span class="button-icon">▶</span> Start AirSign'; stopBtn.disabled=true;
    showPlaceholder(true,'<div class="camera-icon">◎</div><div>Camera preview unavailable</div><small>Check the error below.</small>'); setStatus('Could not start',false,false);
    if (/NotAllowedError|Permission dismissed|Permission denied/i.test(detail) && !permissionBootstrapAttempted) {
      setMessage('Chrome dismissed the camera prompt in the side panel. Opening the one-time permission page; future sessions should start directly in the panel.', '');
      await openPermissionTab();
      return;
    }
    setMessage(`AirSign failed at stage “${startStage}”: ${detail}`, 'error');
  }
}
async function startAirSign() {
  if (running || starting || waitingForPermission) return;
  permissionBootstrapAttempted = false;
  startBtn.disabled=true; setMessage('Preparing the active webpage…');
  try {
    startStage='checking selected webpage'; await prepareTarget();
    startStage='checking camera permission';
    const state=await permissionState();
    if (state==='prompt' || state==='denied') { await openPermissionTab(); return; }
    // If the permission query is unsupported, attempt access once. If Chrome dismisses
    // the side-panel prompt, startCameraTracking will trigger the normal-tab bootstrap.
    await startCameraTracking();
  } catch(error) {
    starting=false; startBtn.disabled=false; startBtn.innerHTML='<span class="button-icon">▶</span> Start AirSign'; stopBtn.disabled=true;
    setMessage(`AirSign could not start: ${explain(error)}`, 'error'); console.error('AirSign start failed:',error);
  }
}
function sendPanelStatus(text, hand=false) { if (running) setStatus(text,true,hand); }
function sendToPage(payload) {
  if(!Number.isInteger(targetTabId)||!pageBridgeReady||!sessionId) return;
  chrome.runtime.sendMessage({type:'AIRSIGN_GESTURE_FRAME',sessionId,initialTargetTabId,payload}).then(reply=>{
    if(!reply||reply.ok!==true) {
      const detail=reply&&reply.error?reply.error:'No acknowledgement from webpage.';
      if(detail!==lastPageWarning) { lastPageWarning=detail; setMessage(`Camera is tracking, but page control is waiting: ${detail}`,'error'); updateTargetInfo('waiting','bridge-warn'); }
    } else if(lastPageWarning) { lastPageWarning=''; updateTargetInfo('connected','bridge-ok'); setMessage(`Page control connected to “${targetTitle}”. Switch to that webpage to see the cursor.`,'success'); }
  }).catch(error=>{
    const detail=explain(error); if(detail!==lastPageWarning){lastPageWarning=detail;setMessage(`Page control error: ${detail}`,'error');}
  });
}
function onResults(results) {
  const lm=results.multiHandLandmarks&&results.multiHandLandmarks[0];
  drawLandmarks(lm);
  if(!lm) {
    clickPinch=false;
    if(lastPose!=='none') sendToPage({handPresent:false,pose:'none'});
    if(lastPose!=='none') sendPanelStatus('Looking for a hand',false);
    lastPose='none'; return;
  }
  const pose=classify(lm), point=mapPoint(1-lm[8].x,lm[8].y), palm=mapPoint(1-(lm[0].x+lm[9].x)/2,(lm[0].y+lm[9].y)/2);
  const scrollY=(lm[8].y+lm[12].y)/2, now=performance.now();
  if(now-lastSend>=25){lastSend=now;sendToPage({handPresent:true,pose,x:point.x,y:point.y,palmX:palm.x,palmY:palm.y,scrollY,frameTime:now});}
  if(now-lastPanelStatus>350){lastPanelStatus=now;const names={point:'Pointing',click:'Pinch to click',drag:'Fist · drag',scroll:'Two-finger scroll',idle:'Hand detected'};sendPanelStatus(names[pose]||'Tracking',true);}
  lastPose=pose;
}
async function runFrames() {
  if(!running||!video.videoWidth){if(running)animationId=requestAnimationFrame(runFrames);return;}
  if(!processing){processing=true;try{await hands.send({image:video});}catch(error){console.error('AirSign frame processing failed:',explain(error));setMessage(`Hand-tracking error: ${explain(error)}`,'error');}finally{processing=false;}}
  if(running)animationId=requestAnimationFrame(runFrames);
}
function cleanupMedia(sendStatus=true) {
  const wasActive=running||starting; running=false; processing=false; cancelAnimationFrame(animationId);
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  try{video.pause();video.srcObject=null;}catch(_){}
  if(hands){try{hands.close();}catch(_){}hands=null;}
  ctx.clearRect(0,0,canvas.width,canvas.height); showPlaceholder(true,'<div class="camera-icon">◎</div><div>Live camera preview will appear here</div><small>Click Start AirSign to begin tracking in the side panel.</small>');
  cameraStateEl.textContent='CAMERA OFF';cameraBadge.classList.remove('live');statusDot.classList.remove('on');
  startBtn.disabled=false;startBtn.innerHTML='<span class="button-icon">▶</span> Start AirSign';stopBtn.disabled=true;
  clickPinch=false;lastPose='none';lastSend=0;pageBridgeReady=false;
  if(sessionId) chrome.runtime.sendMessage({type:'AIRSIGN_STOP_CURRENT_TARGET',sessionId}).catch(()=>{});
  if(sendStatus&&wasActive){setStatus('Stopped',false,false);setMessage('AirSign stopped. The camera has been turned off.');}
}
async function stopAirSign() { waitingForPermission=false; cleanupMedia(true); starting=false; }

startBtn.addEventListener('click',startAirSign);
stopBtn.addEventListener('click',stopAirSign);
chrome.runtime.onMessage.addListener((message,sender)=>{
  if(!message)return;
  if(message.type==='AIRSIGN_CAMERA_PERMISSION_GRANTED') {
    if(!waitingForPermission)return;
    waitingForPermission=false; permissionTabId=null;
    setMessage('Camera access granted. Starting hand tracking in the side panel…','success');
    startCameraTracking(); return;
  }
  if(message.type==='AIRSIGN_CAMERA_PERMISSION_FAILED') {
    waitingForPermission=false; permissionTabId=null; startBtn.disabled=false; startBtn.innerHTML='<span class="button-icon">▶</span> Start AirSign';
    setMessage(`Camera permission setup failed: ${message.error||'Unknown error'}`,'error'); return;
  }
  if(message.type==='AIRSIGN_TARGET_CHANGED' && sessionId && message.sessionId===sessionId && Number.isInteger(message.targetTabId)) {
    targetTabId=message.targetTabId;targetTitle=message.targetTitle||'Webpage';targetUrl=message.targetUrl||'';pageBridgeReady=false;lastPageWarning='';
    updateTargetInfo('connecting…','bridge-warn');
    chrome.tabs.sendMessage(targetTabId,{type:'AIRSIGN_PING'}).then(reply=>{
      if(reply&&reply.ok&&reply.version===VERSION){pageBridgeReady=true;updateTargetInfo('connected','bridge-ok');}
      else {updateTargetInfo('reload webpage','bridge-warn');}
    }).catch(()=>updateTargetInfo('reload webpage','bridge-warn'));
    if(running)setMessage(`Target changed to “${targetTitle}”. Move your hand while viewing that webpage to control it.`,'success');
  }
});
chrome.tabs.onRemoved.addListener((tabId)=>{
  if(tabId===permissionTabId && waitingForPermission){permissionTabId=null;waitingForPermission=false;startBtn.disabled=false;startBtn.innerHTML='<span class="button-icon">▶</span> Start AirSign';setMessage('Camera setup tab was closed before permission was granted. Click Start AirSign to retry.','error');}
});
window.addEventListener('pagehide',()=>cleanupMedia(false),{once:true});
setStatus('Not started',false,false);
updateTargetInfo('not started');
