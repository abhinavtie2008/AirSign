(() => {
  // Versioned install guard. Older AirSign scripts cannot be safely upgraded
  // in-place because their message listeners were anonymous; ask the user to
  // reload that page once instead of leaving a stale invisible cursor behind.
  const CONTENT_VERSION = '1.0.9';
  if (window.__airSignContentInstalled) {
    if (window.__airSignContentVersion !== CONTENT_VERSION) {
      console.warn('AirSign page bridge is from an older version. Reload this webpage and start AirSign again.');
    }
    return;
  }
  window.__airSignContentInstalled = true;
  window.__airSignContentVersion = CONTENT_VERSION;

  const style = document.createElement('style');
  style.id = '__airsign_style';
  style.textContent = `
    #__airsign_cursor{position:fixed;left:0;top:0;width:54px;height:54px;margin:-27px 0 0 -27px;z-index:2147483647;pointer-events:none;opacity:0;will-change:transform;transition:opacity .12s}
    #__airsign_cursor .ring{position:absolute;inset:2px;border:3px solid rgba(255,255,255,.42);border-radius:50%;box-shadow:0 0 20px rgba(34,211,238,.35)}
    #__airsign_cursor .dot{position:absolute;inset:19px;border-radius:50%;background:#22d3ee;box-shadow:0 0 17px #22d3ee}
    #__airsign_cursor.click .dot{background:#34d399;box-shadow:0 0 18px #34d399;transform:scale(.7)}
    #__airsign_cursor.dragging .dot{background:#f59e0b;box-shadow:0 0 18px #f59e0b;border-radius:5px;transform:scale(.85)}
    #__airsign_cursor.scroll .dot{background:#fbbf24;box-shadow:0 0 18px #fbbf24;border-radius:5px}
    .air-hover{outline:2px solid rgba(34,211,238,.85)!important;outline-offset:3px!important;filter:drop-shadow(0 5px 12px rgba(34,211,238,.18))!important}
    .__airsign_ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border:3px solid #34d399;border-radius:50%;pointer-events:none;z-index:2147483646;animation:__airsign_rip .5s ease-out forwards}
    @keyframes __airsign_rip{to{transform:scale(5);opacity:0}}
  `;
  (document.head || document.documentElement).appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = '__airsign_cursor';
  cursor.innerHTML = '<div class="ring"></div><div class="dot"></div>';
  (document.body || document.documentElement).appendChild(cursor);

  const state = { pose: 'none', x: innerWidth / 2, y: innerHeight / 2, hover: null, pressTarget: null, dragPalm: null, dragCursor: null, scrollAnchor: null, scrollV: 0, lastFrame: 0, active: false };
  const INTERACTIVE = 'button,a,input,select,textarea,label,[role="button"],[onclick],[tabindex],summary,option';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function mapPoint(x, y) { return { x: clamp(x * innerWidth, 0, innerWidth - 1), y: clamp(y * innerHeight, 0, innerHeight - 1) }; }
  function place(x, y) { state.x = x; state.y = y; cursor.style.transform = `translate(${x}px,${y}px)`; }
  function mouseEvt(type, element, x, y) {
    if (!element) return;
    let target = element;
    try {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: type === 'mouseup' ? 0 : 1 }));
    } catch (_) { target = null; }
  }
  function ripple(x, y, color) {
    const el = document.createElement('div'); el.className = '__airsign_ripple'; el.style.left = `${x}px`; el.style.top = `${y}px`;
    if (color) el.style.borderColor = color;
    (document.body || document.documentElement).appendChild(el); setTimeout(() => el.remove(), 560);
  }
  function updateHover(x, y) {
    const under = document.elementFromPoint(x, y);
    const target = under && !cursor.contains(under) ? under.closest(INTERACTIVE) : null;
    if (target !== state.hover) {
      if (state.hover) state.hover.classList.remove('air-hover');
      state.hover = target;
      if (target) target.classList.add('air-hover');
    }
  }
  function airClick(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) { ripple(x, y); return; }
    const target = el.closest(INTERACTIVE) || el;
    mouseEvt('mousedown', target, x, y); mouseEvt('mouseup', target, x, y); mouseEvt('click', target, x, y);
    if (typeof target.focus === 'function') { try { target.focus({ preventScroll: true }); } catch (_) {} }
    ripple(x, y);
  }
  function pressStart(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const target = el.closest(INTERACTIVE) || el;
    mouseEvt('mousedown', target, x, y);
    return target;
  }
  function pressEnd() {
    if (state.pressTarget) { mouseEvt('mouseup', state.pressTarget, state.x, state.y); ripple(state.x, state.y, '#f59e0b'); }
    state.pressTarget = null; state.dragPalm = null; state.dragCursor = null;
  }
  function clearHover() { if (state.hover) state.hover.classList.remove('air-hover'); state.hover = null; }
  function stop() {
    pressEnd(); state.pose = 'none'; state.scrollAnchor = null; state.scrollV = 0; state.active = false;
    cursor.style.opacity = '0'; cursor.classList.remove('click', 'dragging', 'scroll'); clearHover();
    if (state.lastFrame && Date.now() - state.lastFrame < 350) return;
  }
  function handleFrame(msg) {
    state.lastFrame = Date.now(); state.active = true;
    if (!msg.handPresent || msg.pose === 'none') {
      if (state.pose === 'drag') pressEnd();
      state.pose = 'none'; state.scrollAnchor = null; state.scrollV = 0;
      cursor.style.opacity = '0'; cursor.classList.remove('click', 'dragging', 'scroll'); clearHover(); return;
    }
    const prev = state.pose;
    state.pose = msg.pose;
    cursor.style.opacity = '1';
    cursor.classList.remove('click', 'dragging', 'scroll');

    if (prev === 'drag' && state.pose !== 'drag') pressEnd();

    if (state.pose === 'point' || state.pose === 'idle' || state.pose === 'click') {
      if (state.pose !== 'drag') {
        const p = mapPoint(msg.x ?? 0.5, msg.y ?? 0.5);
        if (state.pose !== 'click' || prev !== 'click') place(p.x, p.y);
        else place(state.x, state.y);
        updateHover(state.x, state.y);
      }
      if (state.pose === 'click') {
        cursor.classList.add('click');
        if (prev !== 'click') airClick(state.x, state.y);
      }
      state.scrollAnchor = null; state.scrollV = 0;
    } else if (state.pose === 'drag') {
      const palm = mapPoint(msg.palmX ?? msg.x ?? 0.5, msg.palmY ?? msg.y ?? 0.5);
      if (prev !== 'drag') {
        state.dragPalm = palm; state.dragCursor = { x: state.x, y: state.y };
        state.pressTarget = pressStart(state.x, state.y);
      }
      const dx = palm.x - (state.dragPalm ? state.dragPalm.x : palm.x);
      const dy = palm.y - (state.dragPalm ? state.dragPalm.y : palm.y);
      place(clamp((state.dragCursor ? state.dragCursor.x : state.x) + dx, 0, innerWidth - 1), clamp((state.dragCursor ? state.dragCursor.y : state.y) + dy, 0, innerHeight - 1));
      updateHover(state.x, state.y); cursor.classList.add('dragging');
      mouseEvt('mousemove', document, state.x, state.y);
      state.scrollAnchor = null; state.scrollV = 0;
    } else if (state.pose === 'scroll') {
      if (prev !== 'scroll' || state.scrollAnchor === null) state.scrollAnchor = msg.scrollY;
      const offset = msg.scrollY - state.scrollAnchor;
      let target = 0;
      if (Math.abs(offset) > 0.035) target = Math.sign(offset) * (Math.abs(offset) - 0.035) * 9000;
      const now = performance.now();
      const dt = Math.min(Math.max((now - (state.scrollTime || now)) / 1000, 0), 0.1);
      state.scrollTime = now;
      state.scrollV += (target - state.scrollV) * Math.min(1, dt * 10);
      window.scrollBy(0, state.scrollV * dt);
      cursor.classList.add('scroll');
    } else {
      const p = mapPoint(msg.x ?? 0.5, msg.y ?? 0.5); place(p.x, p.y); updateHover(state.x, state.y);
      state.scrollAnchor = null; state.scrollV = 0;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'AIRSIGN_PING') {
      sendResponse({ ok: true, version: CONTENT_VERSION, href: location.href, title: document.title });
      return true;
    }
    if (message.type === 'AIRSIGN_FRAME') {
      handleFrame(message);
      sendResponse({ ok: true, version: CONTENT_VERSION });
      return true;
    }
    if (message.type === 'AIRSIGN_STOP') {
      stop();
      sendResponse({ ok: true, version: CONTENT_VERSION });
      return true;
    }
    if (message.type === 'AIRSIGN_READY') {
      state.active = true;
      sendResponse({ ok: true, version: CONTENT_VERSION, href: location.href });
      return true;
    }
  });
  window.addEventListener('scroll', () => { if (!state.active) return; }, { passive: true });
  window.addEventListener('pagehide', stop, { once: true });
})();
