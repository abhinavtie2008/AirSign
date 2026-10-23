(() => {
  'use strict';

  const VERSION = '2.3.1';
  if (window.__airsignBubbleVersion) {
    if (window.__airsignBubbleVersion !== VERSION) {
      console.warn(`AirSign: camera bubble ${window.__airsignBubbleVersion} is stale; reload this page.`);
    }
    return;
  }
  window.__airsignBubbleVersion = VERSION;

  const POS_KEY = 'airsignBubblePos';
  const MARGIN = 12;
  const CHIP_LABELS = {
    none: 'NO HAND',
    idle: 'OPEN HAND',
    point: 'POINT',
    click: 'CLICK',
    drag: 'FIST',
    scroll: 'SCROLL'
  };

  const host = document.createElement('div');
  host.id = '__airsign_bubble_host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;display:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed; left: 12px; top: 12px;
        pointer-events: auto; touch-action: none;
      }
      .card {
        width: 248px; max-width: calc(100vw - 16px);
        padding: 10px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, .14);
        background: linear-gradient(160deg, rgba(20, 26, 48, .97), rgba(8, 11, 20, .98));
        box-shadow: 0 18px 48px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
        color: #eef1ff;
        font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        -webkit-user-select: none; user-select: none;
        cursor: grab;
      }
      .card.dragging { cursor: grabbing; }
      .top { display: flex; align-items: center; gap: 7px; margin: 0 1px 8px; }
      .mark { display: flex; align-items: center; gap: 2px; }
      .mark i {
        display: block; width: 2.5px; height: 8px; border-radius: 2px;
        background: linear-gradient(180deg, #7c5cff, #22d3ee);
        transform: rotate(22deg);
      }
      .mark i:nth-child(2) { height: 13px; }
      .name { font-size: 11px; font-weight: 800; letter-spacing: .3px; }
      .name span {
        background: linear-gradient(90deg, #7c5cff, #22d3ee);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .grip {
        margin-left: auto; display: grid; grid-template-columns: repeat(2, 2px); gap: 2px;
        opacity: .8; padding: 2px;
      }
      .grip i { width: 2px; height: 2px; border-radius: 50%; background: #4b5578; }
      .pose {
        padding: 4px 7px; border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, .09);
        background: rgba(255, 255, 255, .05);
        color: #98a2c6; font-size: 7.5px; font-weight: 850; letter-spacing: .9px;
        transition: color .15s ease, border-color .15s ease, background .15s ease;
      }
      .pose[data-pose="point"] { color: #22d3ee; border-color: rgba(34, 211, 238, .3); background: rgba(34, 211, 238, .08); }
      .pose[data-pose="click"] { color: #34d399; border-color: rgba(52, 211, 153, .3); background: rgba(52, 211, 153, .08); }
      .pose[data-pose="drag"], .pose[data-pose="scroll"] { color: #fbbf24; border-color: rgba(251, 191, 36, .3); background: rgba(251, 191, 36, .08); }
      .pose[data-pose="idle"] { color: #a5b4fc; border-color: rgba(165, 180, 252, .25); }
      .stage {
        position: relative; aspect-ratio: 16 / 9;
        border-radius: 10px; overflow: hidden;
        border: 1px solid rgba(255, 255, 255, .07);
        background: #06080f;
      }
      .stage canvas { display: block; width: 100%; height: 100%; }
      .live {
        position: absolute; top: 7px; left: 7px;
        display: flex; align-items: center; gap: 4px;
        padding: 3px 6px; border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, .1);
        background: rgba(5, 7, 14, .72);
        font-size: 7.5px; font-weight: 850; letter-spacing: 1px;
      }
      .live i {
        width: 5px; height: 5px; border-radius: 50%;
        background: #f43f5e; box-shadow: 0 0 7px #f43f5e;
        animation: airsign-bubble-pulse 1.6s ease-in-out infinite;
      }
      .card.paused .live i { background: #64748b; box-shadow: none; animation: none; }
      @keyframes airsign-bubble-pulse { 50% { opacity: .4; } }
      .status {
        margin: 8px 1px 0; min-height: 13px;
        color: #98a2c6; font-size: 10px; line-height: 1.35;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .status[hidden] { display: none; }
      .status.error { color: #fb7185; white-space: normal; }
      .status.warn { color: #fbbf24; }
      .legend {
        display: flex; flex-wrap: wrap; gap: 3px 8px;
        margin: 7px 1px 0; color: #6f7a9e; font-size: 8.5px;
      }
      .legend b { color: #98a2c6; font-weight: 700; }
      .actions { display: flex; gap: 6px; margin-top: 9px; }
      .actions button {
        flex: 1; padding: 7px 10px;
        border-radius: 8px;
        font: inherit; font-size: 10.5px; font-weight: 750;
        cursor: pointer;
        transition: background .15s ease, filter .15s ease;
      }
      .actions button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
      .actions button:disabled { opacity: .5; cursor: default; }
      .panel-btn { border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .055); color: #dbe2ff; }
      .panel-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
      .stop-btn { border: 1px solid rgba(251, 113, 133, .32); background: rgba(251, 113, 133, .1); color: #fda4af; }
      .stop-btn:hover:not(:disabled) { background: rgba(251, 113, 133, .18); }
    </style>
    <div class="wrap">
      <div class="card" part="card" role="region" aria-label="AirSign camera bubble. Drag to move.">
        <div class="top">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="name">Air<span>Sign</span></span>
          <span class="grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <span class="pose" data-pose="none">NO HAND</span>
        </div>
        <div class="stage">
          <canvas width="320" height="180" aria-label="Mirrored camera preview with hand landmarks"></canvas>
          <div class="live"><i aria-hidden="true"></i>LIVE</div>
        </div>
        <div class="status" role="status">Starting the camera…</div>
        <div class="legend">
          <span><b>Point</b> move</span>
          <span><b>Pinch</b> click</span>
          <span><b>Fist</b> drag</span>
          <span><b>2 fingers</b> scroll</span>
        </div>
        <div class="actions">
          <button class="panel-btn" type="button">Panel</button>
          <button class="stop-btn" type="button">Stop</button>
        </div>
      </div>
    </div>
  `;

  const wrap = root.querySelector('.wrap');
  const card = root.querySelector('.card');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const poseEl = root.querySelector('.pose');
  const statusEl = root.querySelector('.status');
  const liveEl = root.querySelector('.live');
  const panelBtn = root.querySelector('.panel-btn');
  const stopBtn = root.querySelector('.stop-btn');

  let mounted = false;
  let visible = false;
  let gotPreview = false;
  let decoding = false;
  let queuedPreview = null;
  let position = { fx: 1, fy: 1 };
  let drag = null;

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (_) {
      return Promise.reject(new Error('AirSign is not reachable.'));
    }
  }

  function clearCanvas() {
    ctx.fillStyle = '#06080f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function setPose(pose) {
    const key = pose && CHIP_LABELS[pose] ? pose : 'none';
    if (poseEl.dataset.pose === key) return;
    poseEl.dataset.pose = key;
    poseEl.textContent = CHIP_LABELS[key];
  }

  function setStatus(text, kind = '') {
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.className = 'status';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function setLive(live, paused = false) {
    liveEl.lastChild.textContent = live ? 'LIVE' : paused ? 'PAUSED' : 'OFF';
    card.classList.toggle('paused', !live);
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    (document.body || document.documentElement).appendChild(host);
    clearCanvas();
  }

  function applyPosition() {
    const rect = wrap.getBoundingClientRect();
    const width = rect.width || 248;
    const height = rect.height || 250;
    const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    const x = MARGIN + Math.round(Math.min(1, Math.max(0, position.fx)) * (maxX - MARGIN));
    const y = MARGIN + Math.round(Math.min(1, Math.max(0, position.fy)) * (maxY - MARGIN));
    wrap.style.left = `${Math.min(maxX, Math.max(MARGIN, x))}px`;
    wrap.style.top = `${Math.min(maxY, Math.max(MARGIN, y))}px`;
  }

  function savePosition() {
    try {
      chrome.storage.local.set({ [POS_KEY]: position }).catch(() => {});
    } catch (_) {}
  }

  function show() {
    mount();
    if (!visible) {
      visible = true;
      host.style.display = 'block';
      gotPreview = false;
      setPose('none');
      setLive(false);
      setStatus('Starting the camera…');
      setButtonsBusy(false);
      applyPosition();
      // A navigation can hide the old page and pause the offscreen tracker
      // before this page loads; the new bubble is visible, so resume it.
      if (document.visibilityState === 'visible') {
        send({ type: 'AIRSIGN_BUBBLE_VISIBILITY', visible: true }).catch(() => {});
      }
    } else {
      applyPosition();
    }
  }

  function hide() {
    if (!visible) return;
    visible = false;
    host.style.display = 'none';
    gotPreview = false;
    queuedPreview = null;
    setPose('none');
    clearCanvas();
  }

  async function decodePreview(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  }

  function drawPreview(dataUrl) {
    if (!dataUrl) return;
    if (decoding) {
      queuedPreview = dataUrl;
      return;
    }
    decoding = true;
    decodePreview(dataUrl)
      .then((bitmap) => {
        if (!bitmap) return;
        if (visible) {
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          if (!gotPreview) {
            gotPreview = true;
            setLive(true);
            setStatus('');
          }
        }
        bitmap.close();
      })
      .catch(() => {})
      .finally(() => {
        decoding = false;
        if (queuedPreview) {
          const next = queuedPreview;
          queuedPreview = null;
          drawPreview(next);
        }
      });
  }

  function applyTrackerStatus(state, message) {
    if (state === 'error') {
      setLive(false);
      setStatus(message || 'The camera could not start.', 'error');
    } else if (state === 'paused') {
      setLive(false, true);
      setStatus('Paused while this tab is hidden.');
    } else if (state === 'live') {
      setLive(true);
      if (gotPreview) setStatus('');
    }
  }

  function setButtonsBusy(busy) {
    panelBtn.disabled = busy;
    stopBtn.disabled = busy;
  }

  async function openPanel() {
    setButtonsBusy(true);
    setStatus('Opening the side panel…');
    try {
      const reply = await send({ type: 'AIRSIGN_BUBBLE_EXIT' });
      if (reply && reply.ok) {
        hide();
        return;
      }
      setStatus(reply && reply.error ? reply.error : 'Could not open the side panel. Click the AirSign toolbar icon instead.', 'error');
    } catch (error) {
      setStatus(`Could not reach AirSign (${error.message || error}).`, 'error');
    }
    setButtonsBusy(false);
  }

  async function stopAll() {
    setButtonsBusy(true);
    setStatus('Stopping…');
    try {
      await send({ type: 'AIRSIGN_BUBBLE_STOP' });
      hide();
    } catch (error) {
      setStatus(`Could not stop AirSign (${error.message || error}).`, 'error');
      setButtonsBusy(false);
    }
  }

  panelBtn.addEventListener('click', openPanel);
  stopBtn.addEventListener('click', stopAll);

  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return;
    const rect = wrap.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
    card.classList.add('dragging');
    try {
      card.setPointerCapture(event.pointerId);
    } catch (_) {}
    event.preventDefault();
  });

  card.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = wrap.getBoundingClientRect();
    const maxX = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    const x = Math.min(maxX, Math.max(MARGIN, drag.startLeft + event.clientX - drag.startX));
    const y = Math.min(maxY, Math.max(MARGIN, drag.startTop + event.clientY - drag.startY));
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;
    event.preventDefault();
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    drag = null;
    card.classList.remove('dragging');
    const rect = wrap.getBoundingClientRect();
    const spanX = Math.max(1, window.innerWidth - rect.width - MARGIN - MARGIN);
    const spanY = Math.max(1, window.innerHeight - rect.height - MARGIN - MARGIN);
    position = {
      fx: Math.min(1, Math.max(0, (rect.left - MARGIN) / spanX)),
      fy: Math.min(1, Math.max(0, (rect.top - MARGIN) / spanY))
    };
    savePosition();
  }

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (visible) applyPosition();
  });

  document.addEventListener('visibilitychange', () => {
    if (!visible) return;
    send({ type: 'AIRSIGN_BUBBLE_VISIBILITY', visible: document.visibilityState === 'visible' }).catch(() => {});
  });

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'AIRSIGN_BUBBLE_SHOW') {
        show();
        sendResponse({ ok: true, version: VERSION });
        return;
      }
      if (message.type === 'AIRSIGN_BUBBLE_HIDE') {
        hide();
        sendResponse({ ok: true, version: VERSION });
        return;
      }
      if (message.type === 'AIRSIGN_BUBBLE_PREVIEW') {
        if (visible) {
          setPose(message.pose);
          drawPreview(message.dataUrl);
        }
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'AIRSIGN_BUBBLE_STATUS') {
        if (visible) applyTrackerStatus(message.state, message.message);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'AIRSIGN_STOP') {
        hide();
        sendResponse({ ok: true, version: VERSION });
      }
    });
  }

  (async function init() {
    try {
      const stored = await chrome.storage.local.get(POS_KEY);
      const saved = stored && stored[POS_KEY];
      if (saved && Number.isFinite(saved.fx) && Number.isFinite(saved.fy)) {
        position = { fx: saved.fx, fy: saved.fy };
      }
    } catch (_) {}

    try {
      const reply = await send({ type: 'AIRSIGN_BUBBLE_HELLO' });
      if (reply && reply.show) show();
    } catch (_) {}
  })();

  window.__airsignBubble = {
    version: VERSION,
    show,
    hide,
    get visible() {
      return visible;
    },
    get pose() {
      return poseEl.dataset.pose;
    },
    get status() {
      return statusEl.textContent;
    },
    get hasPreview() {
      return gotPreview;
    },
    get position() {
      const rect = wrap.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
    get buttons() {
      const read = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
      };
      return { panel: read(panelBtn), stop: read(stopBtn) };
    }
  };
})();
