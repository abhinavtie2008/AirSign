(() => {
  'use strict';

  const VERSION = '2.3.2';
  if (window.__airsignBridgeVersion) {
    if (window.__airsignBridgeVersion !== VERSION) {
      console.warn(`AirSign: page bridge ${window.__airsignBridgeVersion} is stale; reload this page.`);
    }
    return;
  }
  window.__airsignBridgeVersion = VERSION;

  const LOST_MS = 350;
  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[contenteditable="true"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // Click assist: the cursor stays under the fingertip, but a click can land on
  // the highlighted target within a small "near miss" radius. Probes sample the
  // page around the cursor so targets with a few pixels of gap are still found.
  const ASSIST_ACQUIRE_PX = 18;
  const ASSIST_HOLD_PX = 28;
  const ASSIST_SWITCH_PX = 10;
  const ASSIST_PROBES = (() => {
    const points = [];
    const directions = [[0, -1], [0.71, -0.71], [1, 0], [0.71, 0.71], [0, 1], [-0.71, 0.71], [-1, 0], [-0.71, -0.71]];
    for (const radius of [8, 14, 20]) {
      for (const [dx, dy] of directions) points.push([Math.round(dx * radius), Math.round(dy * radius)]);
    }
    return points;
  })();

  const state = {
    visible: false,
    frozen: false,
    pose: 'none',
    armed: false,
    active: false,
    assist: true,
    lastFrameAt: 0,
    lostSince: 0,
    target: { x: innerWidth / 2, y: innerHeight / 2 },
    display: { x: innerWidth / 2, y: innerHeight / 2 },
    hovered: null,
    hoverAssisted: false,
    highlightAt: 0,
    dragging: false,
    dragPoint: null,
    dragTarget: null,
    dragAnchor: null,
    dragOrigin: null,
    scrollActive: false,
    scrollContainer: null,
    scrollAnchor: 0,
    scrollSpeed: 0,
    shownDirection: '',
    lastScrollAt: 0,
    lastClickAt: 0,
    lastDragEndAt: 0
  };

  const host = document.createElement('div');
  host.id = '__airsign_layer';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style size;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .cursor {
        position: fixed; left: 0; top: 0; width: 52px; height: 52px;
        margin: -26px 0 0 -26px; pointer-events: none; opacity: 0;
        transition: opacity .14s ease;
        will-change: transform;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .cursor.visible { opacity: 1; }
      .cursor.idle { opacity: .55; }
      .ring {
        position: absolute; inset: 2px; border-radius: 50%;
        border: 2px solid rgba(255,255,255,.5);
        box-shadow: 0 0 18px rgba(34,211,238,.4), inset 0 0 10px rgba(34,211,238,.18);
        transition: border-color .14s ease, box-shadow .14s ease, transform .14s ease;
      }
      .dot {
        position: absolute; inset: 21px; border-radius: 50%;
        background: #22d3ee; box-shadow: 0 0 14px #22d3ee;
        transition: background .14s ease, border-radius .14s ease, transform .14s ease, box-shadow .14s ease;
      }
      .label {
        position: absolute; top: 58px; left: 50%; transform: translateX(-50%);
        padding: 4px 9px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(8,11,20,.94); color: #e8ecff;
        font-size: 10px; font-weight: 700; letter-spacing: .7px;
        white-space: nowrap; opacity: 0;
        transition: opacity .14s ease;
      }
      .cursor.visible .label { opacity: 1; }
      .cursor.click .dot { background: #34d399; box-shadow: 0 0 16px #34d399; transform: scale(.72); }
      .cursor.click .ring { border-color: rgba(52,211,153,.85); box-shadow: 0 0 22px rgba(52,211,153,.5); transform: scale(.9); }
      .cursor.drag .dot { background: #fbbf24; box-shadow: 0 0 16px #fbbf24; border-radius: 4px; transform: scale(.9); }
      .cursor.drag .ring { border-color: rgba(251,191,36,.8); box-shadow: 0 0 22px rgba(251,191,36,.4); }
      .cursor.scroll .dot { background: #fbbf24; box-shadow: 0 0 16px #fbbf24; border-radius: 4px; }
      .cursor.scroll .ring { border-color: rgba(251,191,36,.65); }
      .hover-box {
        position: fixed; pointer-events: none; opacity: 0;
        border: 2px solid rgba(34,211,238,.8);
        box-shadow: 0 0 0 3px rgba(34,211,238,.10), 0 10px 30px rgba(34,211,238,.16);
        border-radius: 10px;
        transition: opacity .1s ease, left .06s linear, top .06s linear, width .06s linear, height .06s linear, border-color .16s ease, box-shadow .16s ease;
      }
      .hover-box.visible { opacity: 1; }
      .hover-box.fired {
        border-color: rgba(52,211,153,.95);
        box-shadow: 0 0 0 3px rgba(52,211,153,.16), 0 10px 30px rgba(52,211,153,.28);
      }
      .hover-tag {
        display: none; position: absolute; left: -2px; bottom: calc(100% + 7px);
        align-items: center; gap: 6px; max-width: 260px;
        padding: 4px 9px; border-radius: 8px;
        border: 1px solid rgba(34,211,238,.45);
        background: rgba(8,11,20,.96); color: #e8ecff;
        box-shadow: 0 8px 22px rgba(0,0,0,.35);
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 10px; line-height: 1.25; letter-spacing: .2px; white-space: nowrap;
      }
      .hover-box.tagging .hover-tag { display: flex; }
      .hover-box.tag-below .hover-tag { bottom: auto; top: calc(100% + 7px); }
      .hover-tag-kicker {
        flex: none; color: #22d3ee; font-size: 9px; font-weight: 800; letter-spacing: .8px;
      }
      .hover-tag-name {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600;
      }
      .ripple {
        position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px;
        border: 2px solid #34d399; border-radius: 50%; pointer-events: none;
        animation: airsign-ripple .55s ease-out forwards;
      }
      @keyframes airsign-ripple {
        from { transform: scale(.6); opacity: .95; }
        to { transform: scale(5); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .cursor, .ring, .dot, .label, .hover-box { transition: none; }
        .ripple { animation-duration: .01s; }
      }
    </style>
    <div class="hover-box">
      <span class="hover-tag"><span class="hover-tag-kicker">CLICK</span><span class="hover-tag-name"></span></span>
    </div>
    <div class="cursor"><div class="ring"></div><div class="dot"></div><div class="label">POINT</div></div>
    <div class="ripples"></div>
  `;

  document.documentElement.appendChild(host);

  const cursorEl = root.querySelector('.cursor');
  const labelEl = root.querySelector('.label');
  const hoverBox = root.querySelector('.hover-box');
  const hoverTag = root.querySelector('.hover-tag');
  const hoverTagName = root.querySelector('.hover-tag-name');
  const rippleLayer = root.querySelector('.ripples');

  let rafId = 0;
  let lastTick = 0;

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function isPageSurface(element) {
    return !element || element === document.documentElement || element === document.body;
  }

  function elementAt(x, y) {
    return document.elementFromPoint(x, y);
  }

  function interactiveAt(x, y) {
    const el = elementAt(x, y);
    if (!el || isPageSurface(el)) return null;
    return el.closest(INTERACTIVE);
  }

  function isEligibleTarget(element) {
    if (!element || !element.isConnected) return false;
    if (element.matches(':disabled, [aria-disabled="true"], [inert]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false;
    return true;
  }

  function rectDistance(rect, x, y) {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.hypot(dx, dy);
  }

  function visibleCenter(rect) {
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, innerWidth);
    const bottom = Math.min(rect.bottom, innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }

  function targetName(element) {
    const attr = (name) => (element.getAttribute(name) || '').replace(/\s+/g, ' ').trim();
    let name = attr('aria-label');
    if (!name) {
      const ids = attr('aria-labelledby');
      if (ids) {
        name = ids.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ').replace(/\s+/g, ' ').trim();
      }
    }
    if (!name) name = attr('title') || attr('placeholder') || attr('alt');
    if (!name && element.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(element.type)) name = element.value;
    if (!name) name = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      const image = element.querySelector('img[alt]');
      if (image && image.alt) name = image.alt.trim();
    }
    if (!name) name = 'element';
    return name.length > 44 ? `${name.slice(0, 43).trimEnd()}…` : name;
  }

  /** Nearest candidate around the cursor, used only when the cursor is not already over a target. */
  function nearbyTarget(x, y) {
    let best = null;
    let bestScore = Infinity;
    const rects = new Map();
    for (const [dx, dy] of ASSIST_PROBES) {
      const element = interactiveAt(x + dx, y + dy);
      if (!isEligibleTarget(element)) continue;
      let rect = rects.get(element);
      if (!rect) {
        rect = element.getBoundingClientRect();
        rects.set(element, rect);
      }
      if (rectDistance(rect, x, y) > ASSIST_ACQUIRE_PX) continue;
      const center = visibleCenter(rect);
      const score = Math.hypot(center.x - x, center.y - y);
      if (score < bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  function showHover(element, assisted, changed) {
    if (!element) {
      clearHover();
      return;
    }
    const rect = element.getBoundingClientRect();
    const radius = Math.min(parseFloat(getComputedStyle(element).borderRadius) || 8, 20);
    hoverBox.style.left = `${rect.left - 3}px`;
    hoverBox.style.top = `${rect.top - 3}px`;
    hoverBox.style.width = `${rect.width + 6}px`;
    hoverBox.style.height = `${rect.height + 6}px`;
    hoverBox.style.borderRadius = `${radius + 3}px`;
    hoverBox.classList.add('visible');
    hoverBox.classList.toggle('tagging', state.assist);
    hoverBox.classList.toggle('tag-below', rect.top < 40);
    hoverTag.style.maxWidth = `${Math.max(120, Math.min(260, innerWidth - Math.max(rect.left, 0) - 14))}px`;
    if (changed) hoverTagName.textContent = targetName(element);
    state.hovered = element;
    state.hoverAssisted = assisted;
  }

  function clearHover() {
    state.hovered = null;
    state.hoverAssisted = false;
    hoverBox.classList.remove('visible', 'tagging', 'tag-below', 'fired');
    hoverTagName.textContent = '';
  }

  function ripple(x, y, color) {
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (color) el.style.borderColor = color;
    rippleLayer.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  function pointerOptions(x, y, buttons) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };
  }

  function mouseOptions(x, y, buttons, detail = 0) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons,
      detail
    };
  }

  function dispatch(target, type, x, y, buttons, detail = 0) {
    if (!target) return;
    try {
      if (type.startsWith('pointer')) target.dispatchEvent(new PointerEvent(type, pointerOptions(x, y, buttons)));
      else target.dispatchEvent(new MouseEvent(type, mouseOptions(x, y, buttons, detail)));
    } catch (_) { /* ignore synthetic-event edge cases */ }
  }

  function focusElement(element) {
    if (!element || typeof element.focus !== 'function') return;
    try { element.focus({ preventScroll: true }); } catch (_) {}
  }

  /** A full, faithful click gesture: pointer + mouse + click, as a real mouse emits. */
  function clickAt(x, y) {
    const element = elementAt(x, y);
    if (!element) { ripple(x, y); return false; }

    dispatch(element, 'pointerdown', x, y, 1);
    dispatch(element, 'mousedown', x, y, 1);
    dispatch(element, 'pointerup', x, y, 0);
    dispatch(element, 'mouseup', x, y, 0);
    dispatch(element, 'click', x, y, 0, 1);

    focusElement(element.closest(INTERACTIVE) || element);
    ripple(x, y);
    return true;
  }

  /** Click the previewed element itself, so a near miss still hits what was highlighted. */
  function clickElement(element, x, y) {
    dispatch(element, 'pointerdown', x, y, 1);
    dispatch(element, 'mousedown', x, y, 1);
    dispatch(element, 'pointerup', x, y, 0);
    dispatch(element, 'mouseup', x, y, 0);
    dispatch(element, 'click', x, y, 0, 1);
    focusElement(element);
    ripple(x, y);
    return true;
  }

  let firedTimer = 0;
  function flashTarget() {
    hoverBox.classList.add('fired');
    clearTimeout(firedTimer);
    firedTimer = setTimeout(() => hoverBox.classList.remove('fired'), 300);
  }

  function startDrag(x, y) {
    const element = elementAt(x, y);
    state.dragging = true;
    state.dragTarget = element || null;
    state.dragPoint = { x, y };
    if (element) {
      dispatch(element, 'pointerdown', x, y, 1);
      dispatch(element, 'mousedown', x, y, 1);
    }
  }

  function moveDrag(x, y) {
    if (!state.dragging) return;
    const element = elementAt(x, y) || state.dragTarget || document;
    dispatch(element, 'pointermove', x, y, 1);
    dispatch(element, 'mousemove', x, y, 1);
  }

  function endDrag(x, y) {
    if (!state.dragging) return;
    const element = elementAt(x, y) || state.dragTarget || document;
    dispatch(element, 'pointerup', x, y, 0);
    dispatch(element, 'mouseup', x, y, 0);
    state.dragging = false;
    state.dragTarget = null;
    state.dragPoint = null;
    state.lastDragEndAt = performance.now();
    ripple(x, y, '#fbbf24');
  }

  function findScrollContainer(x, y) {
    let el = elementAt(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
      if (scrollable) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function startScroll(x, y) {
    state.scrollActive = true;
    state.scrollContainer = findScrollContainer(x, y);
    state.scrollAnchor = 0;
    state.scrollSpeed = 0;
    state.lastScrollAt = performance.now();
  }

  function stopScroll() {
    state.scrollActive = false;
    state.scrollContainer = null;
    state.scrollSpeed = 0;
  }

  /**
   * Page CSS commonly sets scroll-behavior: smooth. Updating scrollTop every
   * frame would restart that animation each time, making the gesture stall or
   * jitter, so the gesture always scrolls instantly in its own loop.
   */
  function scrollByInstant(container, amount) {
    container.scrollTo({ top: container.scrollTop + amount, behavior: 'instant' });
  }

  function updateHover(force = false) {
    const now = performance.now();
    if (!force && now - state.highlightAt < 80) return;
    state.highlightAt = now;

    const x = state.display.x;
    const y = state.display.y;
    const direct = interactiveAt(x, y);
    const exact = isEligibleTarget(direct) ? direct : null;
    if (exact) {
      showHover(exact, false, exact !== state.hovered);
      return;
    }

    if (!state.assist) {
      if (state.hovered) clearHover();
      return;
    }

    let held = isEligibleTarget(state.hovered) ? state.hovered : null;
    let heldScore = Infinity;
    if (held) {
      const rect = held.getBoundingClientRect();
      if (rectDistance(rect, x, y) > ASSIST_HOLD_PX) {
        held = null;
      } else {
        const center = visibleCenter(rect);
        heldScore = Math.hypot(center.x - x, center.y - y);
      }
    }

    const candidate = nearbyTarget(x, y);
    let target = held;
    let assisted = Boolean(held);
    if (candidate && candidate !== held) {
      const center = visibleCenter(candidate.getBoundingClientRect());
      const score = Math.hypot(center.x - x, center.y - y);
      // Sticky: only switch once the new target is clearly closer, so the
      // highlight does not flicker when the cursor rests between two controls.
      if (!held || score < heldScore - ASSIST_SWITCH_PX) {
        target = candidate;
        assisted = true;
      }
    } else if (candidate) {
      target = candidate;
      assisted = true;
    }

    if (!target) {
      if (state.hovered) clearHover();
      return;
    }
    showHover(target, assisted, target !== state.hovered);
  }

  function setPoseVisual(pose) {
    cursorEl.classList.remove('click', 'drag', 'scroll', 'idle');
    const labels = {
      point: 'POINT',
      click: 'CLICK',
      drag: 'DRAG',
      scroll: 'SCROLL',
      idle: 'OPEN HAND',
      none: 'NO HAND'
    };
    labelEl.textContent = labels[pose] || 'POINT';
    if (pose === 'click') cursorEl.classList.add('click');
    else if (pose === 'drag') cursorEl.classList.add('drag');
    else if (pose === 'scroll') cursorEl.classList.add('scroll');
    else if (pose === 'idle') cursorEl.classList.add('idle');
  }

  function showCursor() {
    if (!state.visible) {
      state.visible = true;
      cursorEl.classList.add('visible');
      cursorEl.style.transform = `translate3d(${state.display.x}px, ${state.display.y}px, 0)`;
    }
  }

  function hideCursor() {
    state.visible = false;
    cursorEl.classList.remove('visible', 'click', 'drag', 'scroll', 'idle');
    clearHover();
  }

  function setLabel(text) {
    if (labelEl.textContent !== text) labelEl.textContent = text;
  }

  function stopInteraction() {
    endDrag(state.display.x, state.display.y);
    stopScroll();
  }

  function onFrame(frame) {
    ensureHost();
    const now = performance.now();
    state.lastFrameAt = now;

    if (!frame || !frame.handPresent || frame.pose === 'none') {
      if (!state.lostSince) state.lostSince = now;
      // Keep a drag alive through a short dropout; the loop releases it after LOST_MS.
      if (!state.dragging) state.pose = 'none';
      setLabel('NO HAND');
      return;
    }

    state.lostSince = 0;
    if (frame.assist === false) {
      if (state.assist) {
        state.assist = false;
        state.hoverAssisted = false;
        hoverBox.classList.remove('tagging');
      }
    } else if (!state.assist) {
      state.assist = true;
    }
    const pose = frame.pose;
    const previous = state.pose;
    state.pose = pose;
    state.active = true;
    startLoop();

    if (previous === 'drag' && pose !== 'drag') endDrag(state.display.x, state.display.y);
    if (previous === 'scroll' && pose !== 'scroll') stopScroll();

    if (pose === 'point') {
      state.frozen = false;
      state.target.x = frame.x * innerWidth;
      state.target.y = frame.y * innerHeight;
      if (!state.visible) {
        state.display.x = state.target.x;
        state.display.y = state.target.y;
      }
      state.armed = true;
      state.lastScrollAt = 0;
      showCursor();
      setPoseVisual('point');
      setLabel('POINT');

    } else if (pose === 'click') {
      if (previous !== 'click') {
        // Freeze the preview that was on screen, then click that target once.
        state.frozen = true;
        state.target = { ...state.display };
        const clickable = state.armed && now - state.lastDragEndAt > 260 && now - state.lastClickAt > 150;
        if (clickable) {
          state.lastClickAt = now;
          const preview = state.assist && isEligibleTarget(state.hovered) ? state.hovered : null;
          if (preview) {
            const point = state.hoverAssisted
              ? visibleCenter(preview.getBoundingClientRect())
              : { x: state.display.x, y: state.display.y };
            clickElement(preview, point.x, point.y);
            flashTarget();
          } else {
            clickAt(state.display.x, state.display.y);
          }
        }
      }
      state.frozen = true;
      showCursor();
      setPoseVisual('click');
      setLabel('CLICK');
      if (!state.assist) updateHover(true);

    } else if (pose === 'drag') {
      state.frozen = false;
      clearHover();
      if (previous !== 'drag') {
        state.dragAnchor = { x: frame.palmX, y: frame.palmY };
        state.dragOrigin = { x: state.display.x, y: state.display.y };
        startDrag(state.display.x, state.display.y);
        state.armed = true;
      }
      const anchor = state.dragAnchor || { x: frame.palmX, y: frame.palmY };
      const origin = state.dragOrigin || state.display;
      state.target.x = origin.x + (frame.palmX - anchor.x) * innerWidth;
      state.target.y = origin.y + (frame.palmY - anchor.y) * innerHeight;
      state.target.x = Math.max(0, Math.min(innerWidth - 1, state.target.x));
      state.target.y = Math.max(0, Math.min(innerHeight - 1, state.target.y));
      showCursor();
      setPoseVisual('drag');
      setLabel('DRAG');

    } else if (pose === 'scroll') {
      state.frozen = true;
      clearHover();
      state.target = { ...state.display };
      if (previous !== 'scroll') {
        startScroll(state.display.x, state.display.y);
        state.scrollAnchor = frame.scrollY;
        state.scrollSpeed = 0;
        state.shownDirection = '';
        state.armed = true;
      }
      const offset = frame.scrollY - state.scrollAnchor;
      const dead = 0.03;
      let speed = 0;
      if (Math.abs(offset) > dead) speed = Math.sign(offset) * (Math.abs(offset) - dead) * 7000;
      speed = Math.max(-2400, Math.min(2400, speed));
      state.scrollSpeed += (speed - state.scrollSpeed) * 0.35;
      const direction = state.scrollSpeed > 60 ? 'SCROLL DOWN' : state.scrollSpeed < -60 ? 'SCROLL UP' : 'SCROLL';
      if (direction !== state.shownDirection) {
        state.shownDirection = direction;
        setLabel(direction);
      }
      showCursor();
      setPoseVisual('scroll');

    } else {
      state.frozen = false;
      showCursor();
      setPoseVisual('idle');
      setLabel('OPEN HAND');
    }

    updateHover();
  }

  function tick(now) {
    if (!state.active) { rafId = 0; lastTick = 0; return; }
    rafId = requestAnimationFrame(tick);
    ensureHost();

    const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.05) : 0.016;
    lastTick = now;

    const noFrames = now - state.lastFrameAt > LOST_MS;
    const handGone = state.lostSince && now - state.lostSince > LOST_MS;
    if (noFrames || handGone) {
      if (state.dragging) endDrag(state.display.x, state.display.y);
      stopScroll();
      hideCursor();
      state.pose = 'none';
      state.active = false;
      state.armed = false;
      state.lostSince = 0;
      rafId = 0;
      lastTick = 0;
      return;
    }

    if (state.scrollActive) {
      const container = state.scrollContainer || document.scrollingElement || document.documentElement;
      const dy = state.scrollSpeed * dt;
      if (Math.abs(dy) > 0.1) {
        const before = container.scrollTop;
        scrollByInstant(container, dy);
        if (container !== (document.scrollingElement || document.documentElement) && container.scrollTop === before) {
          scrollByInstant(document.scrollingElement || document.documentElement, dy);
        }
      }
    }

    if (!state.frozen) {
      const ease = 1 - Math.exp(-dt / 0.012);
      const dx = state.target.x - state.display.x;
      const dy = state.target.y - state.display.y;
      if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) {
        state.display.x = state.target.x;
        state.display.y = state.target.y;
      } else {
        state.display.x += dx * ease;
        state.display.y += dy * ease;
      }
    }

    if (state.visible) {
      cursorEl.style.transform = `translate3d(${state.display.x}px, ${state.display.y}px, 0)`;
      if (state.dragging) moveDrag(state.display.x, state.display.y);
      if (state.pose !== 'drag') {
        state.dragAnchor = null;
        state.dragOrigin = null;
      }
      if (state.pose === 'point' || state.pose === 'idle') updateHover();
    }
  }

  function startLoop() {
    if (!rafId) {
      lastTick = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function stopBridge() {
    stopInteraction();
    hideCursor();
    state.pose = 'none';
    state.active = false;
    state.frozen = false;
    state.armed = false;
    state.lastFrameAt = 0;
    state.lostSince = 0;
    state.dragAnchor = null;
    state.dragOrigin = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastTick = 0;
  }

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'AIRSIGN_PING') {
        sendResponse({ ok: true, version: VERSION, title: document.title, href: location.href });
        return;
      }
      if (message.type === 'AIRSIGN_FRAME') {
        onFrame(message.payload || message);
        sendResponse({ ok: true, version: VERSION });
        return;
      }
      if (message.type === 'AIRSIGN_STOP') {
        stopBridge();
        sendResponse({ ok: true, version: VERSION });
      }
    });
  }

  window.addEventListener('pagehide', stopBridge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopInteraction();
  });

  // Exposed for the sandbox page and for manual testing without the extension.
  window.__airsignBridge = {
    version: VERSION,
    handleFrame: onFrame,
    stop: stopBridge,
    get state() {
      return {
        pose: state.pose,
        visible: state.visible,
        dragging: state.dragging,
        assist: state.assist,
        hovered: state.hovered ? targetName(state.hovered) : null,
        assisted: state.hoverAssisted,
        display: { ...state.display },
        target: { ...state.target }
      };
    }
  };
})();
