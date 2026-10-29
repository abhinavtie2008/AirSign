'use strict';

const VERSION = '2.5.1';

const $ = (id) => document.getElementById(id);
const framePill = $('framePill');
const posePill = $('posePill');
const hudHand = $('hudHand');
const hudPose = $('hudPose');
const hudCursor = $('hudCursor');
const hudPinch = $('hudPinch');
const hudRate = $('hudRate');
const countEl = $('count');
const slider = $('slider');
const sliderFill = $('sliderFill');
const sliderThumb = $('sliderThumb');
const sliderValue = $('sliderValue');
const stage = $('stage');
const note = $('note');
const logEl = $('log');

const POSE_LABELS = {
  none: 'NO HAND',
  idle: 'OPEN HAND',
  point: 'POINT',
  click: 'PINCH',
  drag: 'FIST',
  scroll: 'SCROLL'
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/* ------------------------------------------------------------------ */
/* Live gesture HUD                                                    */
/* ------------------------------------------------------------------ */

let lastFrameAt = 0;
let receiving = false;
let lastHudAt = 0;
const frameTimes = [];

const bridge = window.__airsignBridge;
if (!bridge) {
  framePill.textContent = 'Page bridge missing';
  framePill.className = 'pill waiting';
  console.error('AirSign: content.js did not load on the sandbox page.');
} else if (bridge.version !== VERSION) {
  framePill.textContent = 'Bridge version mismatch';
  framePill.className = 'pill waiting';
  console.warn(`AirSign: sandbox bridge is ${bridge.version}, expected ${VERSION}.`);
}

function setFramePill(text, kind) {
  framePill.textContent = text;
  framePill.className = `pill${kind ? ` ${kind}` : ''}`;
}

function setPosePill(pose) {
  const key = POSE_LABELS[pose] ? pose : 'none';
  posePill.textContent = POSE_LABELS[key];
  posePill.className = `pill pose${key !== 'none' && key !== 'idle' ? ` ${key}` : ''}`;
}

function setHudIdle(message) {
  hudHand.textContent = '—';
  hudPose.textContent = message;
  hudCursor.textContent = '—';
  hudPinch.textContent = '—';
  hudRate.textContent = '—';
  setPosePill('none');
}

function updateFrameRate(now) {
  while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
  hudRate.textContent = frameTimes.length ? `${frameTimes.length} frames/s` : '—';
}

function receiveFrame(payload) {
  const now = Date.now();
  lastFrameAt = now;
  frameTimes.push(now);
  while (frameTimes.length > 90) frameTimes.shift();

  if (!receiving) {
    receiving = true;
    setFramePill('Receiving frames', 'live');
  }

  if (!payload || !payload.handPresent) {
    hudHand.textContent = 'Not detected';
    hudPose.textContent = 'No hand';
    hudCursor.textContent = '—';
    hudPinch.textContent = '—';
    setPosePill('none');
    updateFrameRate(now);
    return;
  }

  hudHand.textContent = 'Detected';
  hudPose.textContent = POSE_LABELS[payload.pose] || payload.pose || '—';
  hudCursor.textContent = `${Math.round(payload.x * 100)}% · ${Math.round(payload.y * 100)}%`;
  hudPinch.textContent = Number.isFinite(payload.pinchRatio)
    ? `${Math.round(payload.pinchRatio * 100)}%`
    : '—';
  setPosePill(payload.pose);
  updateFrameRate(now);
}

function markStopped(message = 'AirSign stopped') {
  receiving = false;
  frameTimes.length = 0;
  setFramePill(message, 'waiting');
  setHudIdle('No frames');
}

function updateStale(now) {
  if (!receiving) return;
  if (now - lastFrameAt > 900) {
    receiving = false;
    frameTimes.length = 0;
    setFramePill('Waiting for AirSign', 'waiting');
    setHudIdle('No frames');
  }
}

if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'AIRSIGN_FRAME') receiveFrame(message.payload || message);
    else if (message.type === 'AIRSIGN_STOP') markStopped();
  });
}

setInterval(() => updateStale(Date.now()), 700);

/* ------------------------------------------------------------------ */
/* Event log                                                           */
/* ------------------------------------------------------------------ */

function describeTarget(node) {
  const el = node && node.closest ? node.closest('button, a, .slider, .note, [role="slider"]') : null;
  if (!el) return '';
  if (el.id === 'slider') return 'slider handle';
  if (el.id === 'note') return 'note card';
  if (el.dataset && el.dataset.toggle) return `toggle “${el.dataset.toggle}”`;
  if (el.dataset && el.dataset.name) return `card “${el.dataset.name}”`;
  if (el.id === 'plus' || el.id === 'minus' || el.id === 'reset') return `button #${el.id} → ${el.textContent.trim()}`;
  if (el.id) return `${el.tagName.toLowerCase()} #${el.id}`;
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36);
  return `${el.tagName.toLowerCase()}${text ? ` “${text}”` : ''}`;
}

function addLog(kind, detail) {
  const empty = logEl.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('li');
  const kindEl = document.createElement('span');
  kindEl.className = `kind ${kind}`;
  kindEl.textContent = kind;
  const detailEl = document.createElement('span');
  detailEl.className = 'detail';
  detailEl.textContent = detail;
  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = new Date().toLocaleTimeString([], { hour12: false });

  row.append(kindEl, detailEl, timeEl);
  logEl.prepend(row);
  while (logEl.children.length > 40) logEl.lastElementChild.remove();
}

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const label = describeTarget(event.target);
  if (label) addLog('grab', label);
}, true);

document.addEventListener('click', (event) => {
  const el = event.target.closest ? event.target.closest('button, a') : null;
  if (!el || el.id === 'clearLog') return;
  addLog('click', describeTarget(el));
});

$('clearLog').addEventListener('click', () => {
  logEl.replaceChildren();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = 'Log cleared. Waiting for input…';
  logEl.appendChild(empty);
});

/* ------------------------------------------------------------------ */
/* Counter                                                             */
/* ------------------------------------------------------------------ */

let count = 0;
function setCount(next) {
  count = next;
  countEl.textContent = String(count);
}
$('plus').addEventListener('click', () => setCount(count + 1));
$('minus').addEventListener('click', () => setCount(count - 1));
$('reset').addEventListener('click', () => setCount(0));

/* ------------------------------------------------------------------ */
/* Toggles and likes                                                   */
/* ------------------------------------------------------------------ */

for (const toggle of document.querySelectorAll('.toggle')) {
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(on));
  });
}

for (const card of document.querySelectorAll('.like')) {
  card.addEventListener('click', () => {
    const liked = !card.classList.contains('liked');
    card.classList.toggle('liked', liked);
    card.setAttribute('aria-pressed', String(liked));
    const total = Number(card.dataset.count || 0) + (liked ? 1 : -1);
    card.dataset.count = String(Math.max(0, total));
    card.querySelector('small').textContent = `${Math.max(0, total)} ${total === 1 ? 'like' : 'likes'}`;
  });
}

/* ------------------------------------------------------------------ */
/* Drag slider                                                         */
/* ------------------------------------------------------------------ */

let sliderPercent = 50;
let sliderDragging = false;

function setSliderPercent(percent) {
  sliderPercent = clamp(Math.round(percent), 0, 100);
  sliderFill.style.width = `${sliderPercent}%`;
  sliderThumb.style.left = `${sliderPercent}%`;
  sliderValue.textContent = `${sliderPercent}%`;
  slider.setAttribute('aria-valuenow', String(sliderPercent));
}

function setSliderFromPointer(clientX) {
  const rect = slider.getBoundingClientRect();
  if (!rect.width) return;
  setSliderPercent(((clientX - rect.left) / rect.width) * 100);
}

slider.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  sliderDragging = true;
  slider.classList.add('active');
  setSliderFromPointer(event.clientX);
  event.preventDefault();
  addLog('grab', 'slider handle');
});

slider.addEventListener('keydown', (event) => {
  const delta = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[event.key];
  if (delta) {
    setSliderPercent(sliderPercent + delta);
    event.preventDefault();
  } else if (event.key === 'Home') {
    setSliderPercent(0);
    event.preventDefault();
  } else if (event.key === 'End') {
    setSliderPercent(100);
    event.preventDefault();
  }
});

/* ------------------------------------------------------------------ */
/* Draggable card                                                      */
/* ------------------------------------------------------------------ */

let noteDrag = null;

note.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const noteRect = note.getBoundingClientRect();
  noteDrag = {
    offsetX: event.clientX - noteRect.left,
    offsetY: event.clientY - noteRect.top,
    width: noteRect.width,
    height: noteRect.height
  };
  note.classList.add('dragging');
  event.preventDefault();
  addLog('grab', 'note card');
});

function moveNote(clientX, clientY) {
  if (!noteDrag) return;
  const rect = stage.getBoundingClientRect();
  const left = clamp(clientX - rect.left - noteDrag.offsetX, 0, Math.max(0, rect.width - noteDrag.width));
  const top = clamp(clientY - rect.top - noteDrag.offsetY, 0, Math.max(0, rect.height - noteDrag.height));
  note.style.left = `${left}px`;
  note.style.top = `${top}px`;
}

/* ------------------------------------------------------------------ */
/* Shared pointer end                                                  */
/* ------------------------------------------------------------------ */

window.addEventListener('pointermove', (event) => {
  if (sliderDragging) setSliderFromPointer(event.clientX);
  moveNote(event.clientX, event.clientY);
});

function endPointerAction() {
  if (sliderDragging) {
    sliderDragging = false;
    slider.classList.remove('active');
    addLog('drop', `slider → ${sliderPercent}%`);
  }
  if (noteDrag) {
    noteDrag = null;
    note.classList.remove('dragging');
    addLog('drop', 'note card');
  }
}

window.addEventListener('pointerup', endPointerAction);
window.addEventListener('pointercancel', endPointerAction);

setSliderPercent(50);
setHudIdle('No frames');
