/* AirSign showcase — articulated hand rigs and page interactions. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

document.documentElement.classList.add('js');

/* ------------------------------------------------------------------ */
/* Hand rig                                                            */
/* ------------------------------------------------------------------ */

const PALM_PATH = 'M 149 392 C 136 362 129 330 132 298 C 135 268 147 248 166 240 L 220 240 C 239 248 251 268 254 298 C 257 330 250 362 237 392 Z';

const FINGER_SPECS = {
  thumb: { base: [139, 330], lengths: [40, 34, 28], widths: [31, 29, 26], rest: [-104, -20, -12] },
  index: { base: [158, 242], lengths: [46, 34, 26], widths: [23, 22, 20], rest: [-94, 0, 0] },
  middle: { base: [183, 238], lengths: [50, 37, 28], widths: [24, 23, 21], rest: [-91, 0, 0] },
  ring: { base: [207, 242], lengths: [45, 33, 25], widths: [23, 22, 20], rest: [-88, 0, 0] },
  pinky: { base: [226, 252], lengths: [34, 27, 21], widths: [20, 19, 17], rest: [-83, 0, 0] }
};

const FINGER_ORDER = ['pinky', 'ring', 'middle', 'index', 'thumb'];

const POSES = {
  point: {
    tilt: -2,
    fingers: {
      index: [-94, 0, 0],
      middle: [-80, 120, 96],
      ring: [-84, 124, 98],
      pinky: [-87, 127, 100],
      thumb: [-104, -20, -12]
    }
  },
  pinch: {
    tilt: -1,
    fingers: {
      index: [-70, 100, 80],
      middle: [-80, 118, 96],
      ring: [-84, 122, 98],
      pinky: [-87, 125, 100],
      thumb: [-100, 35, 55]
    }
  },
  fist: {
    tilt: 2,
    fingers: {
      index: [-78, 122, 95],
      middle: [-82, 124, 96],
      ring: [-85, 126, 98],
      pinky: [-88, 128, 100],
      thumb: [-95, 60, 40]
    }
  },
  scroll: {
    tilt: -2,
    fingers: {
      index: [-94, 0, 0],
      middle: [-91, 0, 0],
      ring: [-85, 126, 98],
      pinky: [-88, 130, 100],
      thumb: [-104, -20, -12]
    }
  },
  open: {
    tilt: 0,
    fingers: {
      index: [-96, 0, 0],
      middle: [-92, 0, 0],
      ring: [-87, 0, 0],
      pinky: [-81, 0, 0],
      thumb: [-112, -10, -6]
    }
  }
};

let rigCounter = 0;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function clonePose(pose) {
  const fingers = {};
  for (const [id, angles] of Object.entries(pose.fingers)) fingers[id] = angles.slice();
  return { tilt: pose.tilt, fingers };
}

function lerpPose(from, to, t) {
  const fingers = {};
  for (const id of Object.keys(to.fingers)) {
    const a = from.fingers[id] || to.fingers[id];
    const b = to.fingers[id];
    fingers[id] = [0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * t);
  }
  return { tilt: from.tilt + (to.tilt - from.tilt) * t, fingers };
}

function jointPoints(spec, angles) {
  const points = [spec.base.slice()];
  let x = spec.base[0];
  let y = spec.base[1];
  let angle = angles[0];
  for (let index = 0; index < 3; index += 1) {
    if (index > 0) angle += angles[index];
    const radians = (angle * Math.PI) / 180;
    x += Math.cos(radians) * spec.lengths[index];
    y += Math.sin(radians) * spec.lengths[index];
    points.push([x, y]);
  }
  return points;
}

class HandRig {
  constructor(host, { pose = 'point', cursor = true, onRender = null } = {}) {
    this.host = host;
    this.cursor = cursor;
    this.onRender = onRender;
    this.uid = `rig-${++rigCounter}`;
    this.poseName = '';
    this.current = null;
    this.raf = 0;
    this.fingers = {};
    this.build();
    this.setPose(pose, { animate: false });
  }

  build() {
    const svg = svgEl('svg', {
      viewBox: '0 0 360 430',
      class: 'hand-rig-svg',
      role: 'presentation',
      'aria-hidden': 'true',
      focusable: 'false'
    });

    const defs = svgEl('defs');
    const palmGradient = svgEl('linearGradient', { id: `${this.uid}-palm`, x1: '0', y1: '0', x2: '0.85', y2: '1' });
    palmGradient.append(
      svgEl('stop', { offset: '0', 'stop-color': '#d8ffe8', 'stop-opacity': '0.2' }),
      svgEl('stop', { offset: '0.55', 'stop-color': '#7dffb3', 'stop-opacity': '0.09' }),
      svgEl('stop', { offset: '1', 'stop-color': '#7dffb3', 'stop-opacity': '0.035' })
    );
    const auraGradient = svgEl('radialGradient', { id: `${this.uid}-aura` });
    auraGradient.append(
      svgEl('stop', { offset: '0', 'stop-color': '#8dffbe', 'stop-opacity': '0.22' }),
      svgEl('stop', { offset: '0.55', 'stop-color': '#8dffbe', 'stop-opacity': '0.06' }),
      svgEl('stop', { offset: '1', 'stop-color': '#8dffbe', 'stop-opacity': '0' })
    );
    const cuffGradient = svgEl('linearGradient', { id: `${this.uid}-cuff`, x1: '0', y1: '0', x2: '1', y2: '0' });
    cuffGradient.append(
      svgEl('stop', { offset: '0', 'stop-color': '#0b1510' }),
      svgEl('stop', { offset: '0.5', 'stop-color': '#12251a' }),
      svgEl('stop', { offset: '1', 'stop-color': '#0b1510' })
    );
    defs.append(palmGradient, auraGradient, cuffGradient);
    svg.append(defs);

    const inner = svgEl('g', { class: 'rig-inner' });
    inner.append(
      svgEl('circle', { class: 'rig-aura', cx: '180', cy: '252', r: '184', fill: `url(#${this.uid}-aura)` }),
      svgEl('path', { class: 'rig-cuff', d: 'M 148 380 L 212 380 C 222 380 229 388 229 399 L 229 424 L 131 424 L 131 399 C 131 388 138 380 148 380 Z', fill: `url(#${this.uid}-cuff)` }),
      svgEl('path', { class: 'rig-palm', d: PALM_PATH, fill: `url(#${this.uid}-palm)` }),
      svgEl('path', { class: 'rig-palm-edge', d: PALM_PATH })
    );

    const fingers = svgEl('g', { class: 'rig-fingers' });

    for (const id of FINGER_ORDER) {
      const spec = FINGER_SPECS[id];
      const group = svgEl('g', { class: `rig-finger rig-finger--${id}`, 'data-finger': id });
      const volume = svgEl('polyline', {
        class: 'rig-volume',
        'stroke-width': Math.max(...spec.widths)
      });
      const bone = svgEl('polyline', { class: 'rig-bone', 'stroke-width': '1.4' });
      const joints = svgEl('g', { class: 'rig-joints' });
      for (let index = 0; index < 4; index += 1) {
        joints.append(svgEl('circle', { r: index === 3 ? '3.6' : '2.8' }));
      }
      const tip = svgEl('circle', { class: 'rig-tip', r: '5' });
      group.append(volume, bone, joints, tip);
      fingers.append(group);
      this.fingers[id] = { group, volume, bone, joints, tip };
    }
    inner.append(fingers);

    inner.append(svgEl('circle', { class: 'rig-wrist-joint', cx: '180', cy: '386', r: '4.2' }));

    const cursorGroup = svgEl('g', { class: 'rig-cursor' });
    cursorGroup.append(
      svgEl('circle', { class: 'rig-cursor-halo', r: '15' }),
      svgEl('path', { class: 'rig-cursor-ticks', d: 'M -24 0 H -12 M 12 0 H 24 M 0 -24 V -12 M 0 12 V 24' }),
      svgEl('circle', { class: 'rig-cursor-dot', r: '4.4' })
    );
    inner.append(cursorGroup);

    const contact = svgEl('g', { class: 'rig-contact' });
    contact.append(
      svgEl('circle', { class: 'rig-contact-ring', r: '17' }),
      svgEl('circle', { class: 'rig-contact-core', r: '3' })
    );
    inner.append(contact);

    const grip = svgEl('g', { class: 'rig-grip' });
    grip.append(
      svgEl('circle', { class: 'rig-grip-ring', r: '38' }),
      svgEl('path', { class: 'rig-grip-tick', d: 'M -46 0 H -36 M 36 0 H 46 M 0 -46 V -36 M 0 36 V 46' })
    );
    inner.append(grip);

    const dwell = svgEl('g', { class: 'rig-dwell' });
    dwell.append(
      svgEl('circle', { class: 'rig-dwell-track', r: '25' }),
      svgEl('circle', { class: 'rig-dwell-fill', r: '25' })
    );
    inner.append(dwell);

    if (!this.cursor) inner.classList.add('rig-inner--plain');

    svg.append(inner);
    this.svg = svg;
    this.inner = inner;
    this.cursorGroup = cursorGroup;
    this.contact = contact;
    this.grip = grip;
    this.dwell = dwell;
    this.host.replaceChildren(svg);
  }

  setPose(name, { animate = true } = {}) {
    const target = POSES[name] || POSES.point;
    this.poseName = POSES[name] ? name : 'point';
    this.svg.dataset.pose = this.poseName;

    if (!this.current) {
      this.current = clonePose(target);
      this.render();
      return;
    }

    cancelAnimationFrame(this.raf);
    if (!animate || reducedMotion.matches) {
      this.current = clonePose(target);
      this.render();
      return;
    }

    const from = clonePose(this.current);
    const to = clonePose(target);
    const started = performance.now();
    const duration = 560;
    const step = (now) => {
      const progress = clamp((now - started) / duration, 0, 1);
      this.current = lerpPose(from, to, easeInOutCubic(progress));
      this.render();
      if (progress < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  render() {
    const pose = this.current;
    this.inner.setAttribute('transform', `rotate(${pose.tilt.toFixed(2)} 180 300)`);

    let indexTip = null;
    let thumbTip = null;

    for (const id of FINGER_ORDER) {
      const spec = FINGER_SPECS[id];
      const points = jointPoints(spec, pose.fingers[id]);
      const text = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const node = this.fingers[id];
      node.volume.setAttribute('points', text);
      node.bone.setAttribute('points', text);
      const circles = node.joints.children;
      for (let index = 0; index < circles.length; index += 1) {
        circles[index].setAttribute('cx', points[index][0].toFixed(1));
        circles[index].setAttribute('cy', points[index][1].toFixed(1));
      }
      const tip = points[points.length - 1];
      node.tip.setAttribute('cx', tip[0].toFixed(1));
      node.tip.setAttribute('cy', tip[1].toFixed(1));
      if (id === 'index') indexTip = tip;
      if (id === 'thumb') thumbTip = tip;
    }

    const palmCenter = [186, 320];
    this.grip.setAttribute('transform', `translate(${palmCenter[0]} ${palmCenter[1]})`);

    if (indexTip) {
      this.cursorGroup.setAttribute('transform', `translate(${indexTip[0].toFixed(1)} ${indexTip[1].toFixed(1)})`);
      this.dwell.setAttribute('transform', `translate(${indexTip[0].toFixed(1)} ${indexTip[1].toFixed(1)})`);
    }
    if (indexTip && thumbTip) {
      const x = (indexTip[0] + thumbTip[0]) / 2;
      const y = (indexTip[1] + thumbTip[1]) / 2;
      this.contact.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    }

    this.meta = { pose: this.poseName, indexTip, thumbTip };
    if (this.onRender) this.onRender(this.meta);
  }
}

/* ------------------------------------------------------------------ */
/* Header, navigation, reveal                                          */
/* ------------------------------------------------------------------ */

function initHeader() {
  const header = $('#siteHeader');
  const bar = $('#scrollBar');
  const menuBtn = $('#menuBtn');
  const nav = $('#siteNav');
  if (!header) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
    if (bar) bar.style.transform = `scaleX(${progress})`;
    header.classList.toggle('is-scrolled', window.scrollY > 16);

    const probe = window.scrollY + 150;
    let current = '';
    for (const id of ['playground', 'gestures', 'how', 'install']) {
      const section = document.getElementById(id);
      if (section && section.offsetTop <= probe) current = id;
    }
    $$('.site-nav a').forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${current}`);
    });
  };
  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  update();

  if (!menuBtn || !nav) return;
  const closeMenu = () => {
    nav.classList.remove('is-open');
    header.classList.remove('menu-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  menuBtn.addEventListener('click', () => {
    const open = menuBtn.getAttribute('aria-expanded') !== 'true';
    menuBtn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    header.classList.toggle('menu-open', open);
  });
  $$('a', nav).forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 880) closeMenu();
  });
}

function initReveal() {
  const nodes = $$('[data-reveal]');
  if (!nodes.length) return;
  if (reducedMotion.matches || !('IntersectionObserver' in window)) {
    nodes.forEach((node) => node.classList.add('is-in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -7% 0px' });
  nodes.forEach((node, index) => {
    node.style.setProperty('--reveal-delay', `${(index % 4) * 70}ms`);
    observer.observe(node);
  });
}

/* ------------------------------------------------------------------ */
/* Hero tracker                                                        */
/* ------------------------------------------------------------------ */

const HERO_POSES = {
  point: { label: 'POINT', note: 'cursor follows your index tip', x: '0.50', y: '0.50' },
  pinch: { label: 'PINCH', note: 'click assist snaps to the target', x: '0.65', y: '0.65' },
  fist: { label: 'FIST', note: 'grab a card, open to drop', x: '0.35', y: '0.40' },
  scroll: { label: 'TWO FINGERS', note: 'lift your hand to scroll down', x: '0.90', y: '0.47' }
};

function buildHeroField(host) {
  const svg = svgEl('svg', {
    viewBox: '0 0 560 480',
    class: 'hero-field',
    role: 'presentation',
    'aria-hidden': 'true',
    focusable: 'false'
  });

  const defs = svgEl('defs');
  const glow = svgEl('radialGradient', { id: 'heroFieldGlow' });
  glow.append(
    svgEl('stop', { offset: '0', 'stop-color': '#8dffbe', 'stop-opacity': '0.3' }),
    svgEl('stop', { offset: '0.55', 'stop-color': '#8dffbe', 'stop-opacity': '0.08' }),
    svgEl('stop', { offset: '1', 'stop-color': '#8dffbe', 'stop-opacity': '0' })
  );
  const thumb = svgEl('linearGradient', { id: 'heroCardThumb', x1: '0', y1: '0', x2: '1', y2: '1' });
  thumb.append(
    svgEl('stop', { offset: '0', 'stop-color': '#1b4a30' }),
    svgEl('stop', { offset: '0.55', 'stop-color': '#102c1c' }),
    svgEl('stop', { offset: '1', 'stop-color': '#0a1a11' })
  );
  defs.append(glow, thumb);
  svg.append(defs);

  const text = (x, y, value, className, anchor = 'middle') => {
    const node = svgEl('text', { x, y, class: className, 'text-anchor': anchor });
    node.textContent = value;
    return node;
  };

  const rings = svgEl('g', { class: 'hero-field-rings' });
  for (const radius of [212, 148, 84]) {
    rings.append(svgEl('circle', { class: 'hero-field-ring', cx: '286', cy: '238', r: String(radius) }));
  }

  const frame = svgEl('rect', {
    class: 'hero-frame',
    x: '84',
    y: '74',
    width: '404',
    height: '324',
    rx: '24'
  });

  const chrome = svgEl('g', { class: 'hero-chrome' });
  for (const x of [106, 120, 134]) {
    chrome.append(svgEl('circle', { class: 'hero-chrome-dot', cx: String(x), cy: '96', r: '3' }));
  }

  const cardB = svgEl('g', { class: 'hero-card hero-card--idle' });
  cardB.append(
    svgEl('rect', { class: 'hero-card-shell', x: '300', y: '158', width: '160', height: '96', rx: '14' }),
    svgEl('rect', { class: 'hero-card-thumb', x: '312', y: '170', width: '52', height: '72', rx: '9' }),
    svgEl('rect', { class: 'hero-line', x: '374', y: '174', width: '68', height: '6', rx: '3' }),
    svgEl('rect', { class: 'hero-line', x: '374', y: '188', width: '44', height: '6', rx: '3' }),
    svgEl('rect', { class: 'hero-line hero-line--dim', x: '374', y: '210', width: '56', height: '5', rx: '2.5' })
  );

  const cardA = svgEl('g', { class: 'hero-card hero-card--drag' });
  cardA.append(
    svgEl('rect', { class: 'hero-card-shell', x: '116', y: '140', width: '164', height: '108', rx: '14' }),
    svgEl('rect', { class: 'hero-card-thumb', x: '128', y: '152', width: '56', height: '84', rx: '9' }),
    svgEl('rect', { class: 'hero-line', x: '196', y: '156', width: '68', height: '6', rx: '3' }),
    svgEl('rect', { class: 'hero-line', x: '196', y: '170', width: '48', height: '6', rx: '3' }),
    svgEl('rect', { class: 'hero-line hero-line--dim', x: '196', y: '192', width: '58', height: '5', rx: '2.5' }),
    svgEl('rect', { class: 'hero-line hero-line--dim', x: '196', y: '206', width: '36', height: '5', rx: '2.5' })
  );

  const target = svgEl('g', { class: 'hero-target' });
  target.append(
    svgEl('rect', { class: 'hero-button', x: '300', y: '292', width: '132', height: '42', rx: '12' }),
    text(366, 318, 'OPEN', 'hero-button-label'),
    svgEl('circle', { class: 'hero-target-ring', cx: '366', cy: '313', r: '38' }),
    svgEl('circle', { class: 'hero-click-ripple', cx: '366', cy: '313', r: '22' })
  );

  const rail = svgEl('g', { class: 'hero-rail' });
  rail.append(
    svgEl('rect', { class: 'hero-rail-track', x: '504', y: '136', width: '16', height: '188', rx: '8' }),
    svgEl('rect', { class: 'hero-rail-thumb', x: '507', y: '164', width: '10', height: '52', rx: '5' }),
    svgEl('path', { class: 'hero-rail-chevron', d: 'M 512 140 L 506 148 L 518 148 Z' }),
    svgEl('path', { class: 'hero-rail-chevron', d: 'M 512 320 L 506 312 L 518 312 Z' })
  );

  const trails = svgEl('g', { class: 'hero-trails' });
  const trailPaths = {
    point: 'M 162 352 C 190 320 232 274 282 242',
    pinch: 'M 162 352 C 214 338 292 326 366 313',
    fist: 'M 162 352 C 174 304 186 250 198 194',
    scroll: 'M 162 352 C 258 330 404 296 506 226'
  };
  for (const [id, d] of Object.entries(trailPaths)) {
    trails.append(svgEl('path', { class: `hero-trail hero-trail--${id}`, d }));
  }

  const origin = svgEl('g', { class: 'hero-origin' });
  origin.append(
    svgEl('circle', { class: 'hero-origin-ring', cx: '162', cy: '352', r: '12' }),
    svgEl('circle', { class: 'hero-origin-dot', cx: '162', cy: '352', r: '3' })
  );

  const labels = svgEl('g', { class: 'hero-labels' });
  labels.append(
    text(128, 268, 'CARD / DRAG', 'hero-tag', 'start'),
    text(446, 318, 'CLICK', 'hero-tag', 'start'),
    text(512, 348, 'PAGE / SCROLL', 'hero-tag'),
    text(162, 380, 'INPUT', 'hero-tag')
  );

  const cursor = svgEl('g', { class: 'hero-cursor' });
  const core = svgEl('g', { class: 'hero-cursor-core' });
  core.append(
    svgEl('circle', { class: 'hero-cursor-halo', r: '32' }),
    svgEl('circle', { class: 'hero-cursor-ring', r: '19' }),
    svgEl('path', { class: 'hero-cursor-ticks', d: 'M -27 0 H -20 M 20 0 H 27 M 0 -27 V -20 M 0 20 V 27' }),
    svgEl('path', { class: 'hero-cursor-arrow', d: 'M 0 0 L 0 34 L 8.4 26 L 14.2 41 L 21 38 L 15 23.4 L 26 23.4 Z' }),
    svgEl('circle', { class: 'hero-cursor-tip', r: '2' })
  );
  cursor.append(core);

  const grip = svgEl('g', { class: 'hero-grip', transform: 'translate(198 194)' });
  grip.append(
    svgEl('circle', { class: 'hero-grip-ring', r: '54' }),
    svgEl('path', { class: 'hero-grip-ticks', d: 'M -66 0 H -56 M 56 0 H 66 M 0 -66 V -56 M 0 56 V 66' })
  );

  svg.append(rings, frame, chrome, cardB, cardA, target, rail, trails, origin, labels, cursor, grip);
  host.replaceChildren(svg);
}

function initHero() {
  const stage = $('[data-hero-stage]');
  const host = $('#heroField');
  if (!stage || !host) return;

  const label = $('#heroPoseLabel');
  const note = $('#heroPoseNote');
  const xOut = $('#heroX');
  const yOut = $('#heroY');
  const buttons = $$('[data-hero-pose]', stage);
  const order = ['point', 'pinch', 'fist', 'scroll'];
  let current = 0;
  let autoEnabled = !reducedMotion.matches;
  let pauseUntil = 0;
  let clickTimer = 0;

  buildHeroField(host);

  const apply = (id) => {
    const pose = HERO_POSES[id] || HERO_POSES.point;
    current = order.indexOf(id);
    stage.dataset.pose = id;
    if (label) label.textContent = pose.label;
    if (note) note.textContent = pose.note;
    if (xOut) xOut.textContent = pose.x;
    if (yOut) yOut.textContent = pose.y;
    buttons.forEach((button) => {
      const active = button.dataset.heroPose === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    clearTimeout(clickTimer);
    stage.classList.toggle('is-clicking', id === 'pinch');
    if (id === 'pinch') {
      clickTimer = setTimeout(() => stage.classList.remove('is-clicking'), 720);
    }
  };

  const next = () => {
    if (!autoEnabled || document.hidden || performance.now() < pauseUntil) return;
    apply(order[(current + 1) % order.length]);
  };

  let timer = window.setInterval(next, 3600);
  const restart = () => {
    clearInterval(timer);
    timer = window.setInterval(next, 3600);
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      apply(button.dataset.heroPose);
      pauseUntil = performance.now() + 11000;
      restart();
    });
  });

  stage.addEventListener('pointerenter', () => {
    pauseUntil = performance.now() + 2400;
  });
  stage.addEventListener('focusin', () => {
    pauseUntil = performance.now() + 8000;
  });

  stage.addEventListener('pointermove', (event) => {
    const rect = stage.getBoundingClientRect();
    stage.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    stage.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  });
  stage.addEventListener('pointerleave', () => {
    stage.style.removeProperty('--mx');
    stage.style.removeProperty('--my');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(timer);
      timer = 0;
    } else if (autoEnabled) {
      restart();
    }
  });

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        autoEnabled = !reducedMotion.matches;
        if (!timer) timer = window.setInterval(next, 3600);
      } else {
        autoEnabled = false;
        clearInterval(timer);
        timer = 0;
      }
    }
  }, { threshold: 0.2 });
  observer.observe(stage);

  reducedMotion.addEventListener('change', () => {
    autoEnabled = !reducedMotion.matches;
  });

  apply('point');
}

/* ------------------------------------------------------------------ */
/* Gesture atlas                                                       */
/* ------------------------------------------------------------------ */

const GESTURES = [
  {
    id: 'point',
    code: 'G-01 / POINT',
    name: 'Point',
    title: 'Move the cursor',
    alias: '= MOUSE MOVE',
    pose: 'point',
    fingers: ['index'],
    position: 'Index extended. Palm toward the camera. Hand fully inside the frame.',
    action: 'The index fingertip becomes the pointer. Smoothing keeps it steady while you hold still.',
    steps: [
      'Raise one hand with the palm toward the camera.',
      'Extend your index finger and relax the rest.',
      'Sweep your hand — the fingertip is the pointer.'
    ],
    tip: 'Keep the other fingers loose. A tucked hand reads as a fist.'
  },
  {
    id: 'pinch',
    code: 'G-02 / PINCH',
    name: 'Pinch',
    title: 'Click once',
    alias: '= LEFT CLICK',
    pose: 'pinch',
    fingers: ['thumb', 'index'],
    position: 'Thumb and index tips meet. Palm stays open toward the lens.',
    action: 'Aim first, then touch thumb and index together. Click assist snaps to a nearby target.',
    steps: [
      'Point at the thing you want to press.',
      'Touch your thumb and index tips together.',
      'Release and the click lands once.'
    ],
    tip: 'Pinch deliberately, not quickly. The engine ignores accidental brushes.'
  },
  {
    id: 'drag',
    code: 'G-03 / FIST',
    name: 'Fist',
    title: 'Drag and drop',
    alias: '= CLICK + HOLD',
    pose: 'fist',
    fingers: ['thumb', 'index', 'middle', 'ring', 'pinky'],
    position: 'Close the whole hand into a soft fist. Keep it centered in frame.',
    action: 'The fist grabs whatever is under the cursor. Move, then open your hand to release.',
    steps: [
      'Point at a card, slider, or draggable object.',
      'Close your hand into a fist to grab it.',
      'Move your hand, then open it to drop.'
    ],
    tip: 'Size the fist after aiming. Grabbing mid-air is what starts the drag.'
  },
  {
    id: 'scroll',
    code: 'G-04 / TWO FINGERS',
    name: 'Scroll',
    title: 'Move the page',
    alias: '= MOUSE WHEEL',
    pose: 'scroll',
    fingers: ['index', 'middle'],
    position: 'Index and middle up. Ring and pinky relaxed. Hand upright.',
    action: 'Lift your hand to scroll down, lower it to scroll up. Travel is measured in hand widths.',
    steps: [
      'Raise your index and middle fingers.',
      'Move your hand upward to scroll down.',
      'Lower it to scroll back up.'
    ],
    tip: 'Distance from the camera does not change speed — one hand width is one step.'
  },
  {
    id: 'dwell',
    code: 'G-05 / DWELL',
    name: 'Dwell',
    title: 'Click without pinching',
    alias: '= OPTIONAL CLICK',
    pose: 'point',
    fingers: ['index'],
    position: 'Point at the target and hold still. Keep the fingertip inside the target.',
    action: 'A ring fills while you hold. When it completes, the click lands — no pinch needed.',
    steps: [
      'Turn on Dwell to click in the side panel.',
      'Point at a target and stop moving.',
      'Hold until the progress ring completes.'
    ],
    tip: 'Dwell is off by default. Tune it from 400 ms to 1500 ms for your hand.'
  }
];

const FINGER_KEY = { thumb: 'T', index: 'I', middle: 'M', ring: 'R', pinky: 'P' };
const GESTURE_BY_ID = Object.fromEntries(GESTURES.map((gesture) => [gesture.id, gesture]));

function initAtlas() {
  const section = $('#gestures');
  const tabs = $$('[role="tab"][data-gesture]');
  const host = $('#atlasRig');
  const preview = $('#actionPreview');
  const panel = $('#atlasPanel');
  if (!section || !tabs.length || !host) return;

  const code = $('#atlasCode');
  const alias = $('#atlasAlias');
  const position = $('#atlasPosition');
  const action = $('#atlasAction');
  const steps = [$('#atlasStep1'), $('#atlasStep2'), $('#atlasStep3')];
  const tip = $('#atlasTip');
  const fingerMap = $$('[data-atlas-finger]');
  const autoBtn = $('#atlasAuto');
  const prevBtn = $('#atlasPrev');
  const nextBtn = $('#atlasNext');
  let current = 0;
  let visible = false;
  let paused = false;
  let autoOn = !reducedMotion.matches;
  let timer = 0;
  let replayTimer = 0;

  const rig = new HandRig(host, { pose: 'point' });

  const replay = () => {
    if (!preview) return;
    clearTimeout(replayTimer);
    preview.classList.remove('is-run');
    void preview.offsetWidth;
    preview.classList.add('is-run');
    replayTimer = setTimeout(() => preview.classList.remove('is-run'), 5200);
  };

  const syncAuto = () => {
    if (autoBtn) {
      autoBtn.setAttribute('aria-pressed', String(autoOn));
      autoBtn.classList.toggle('is-on', autoOn);
      autoBtn.querySelector('span').textContent = autoOn ? 'Auto tour on' : 'Auto tour off';
    }
    clearInterval(timer);
    timer = 0;
    if (autoOn && visible && !paused && !document.hidden) {
      timer = window.setInterval(() => select((current + 1) % GESTURES.length), 6400);
    }
  };

  const select = (index, { focus = false } = {}) => {
    current = ((index % GESTURES.length) + GESTURES.length) % GESTURES.length;
    const gesture = GESTURES[current];

    tabs.forEach((tab, tabIndex) => {
      const active = tabIndex === current;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) {
        panel?.setAttribute('aria-labelledby', tab.id);
        if (focus) tab.focus();
        revealTab(tab);
      }
    });

    if (code) code.textContent = gesture.code;
    if (alias) alias.textContent = gesture.alias;
    if (position) position.textContent = gesture.position;
    if (action) action.textContent = gesture.action;
    steps.forEach((step, index) => {
      if (step) step.textContent = gesture.steps[index] || '';
    });
    if (tip) tip.textContent = gesture.tip;
    if (preview) preview.dataset.gesture = gesture.id;
    host.dataset.mode = gesture.id;
    fingerMap.forEach((node) => {
      node.classList.toggle('is-active', gesture.fingers.includes(node.dataset.atlasFinger));
    });
    rig.setPose(gesture.pose);
    replay();
    syncAuto();
  };

  const revealTab = (tab) => {
    const rail = tab.parentElement;
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
    const railRect = rail.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const behavior = reducedMotion.matches ? 'auto' : 'smooth';
    if (tabRect.left < railRect.left + 8) {
      rail.scrollBy({ left: tabRect.left - railRect.left - 8, behavior });
    } else if (tabRect.right > railRect.right - 30) {
      rail.scrollBy({ left: tabRect.right - railRect.right + 30, behavior });
    }
  };

  const next = () => select(current + 1);
  const prev = () => select(current - 1);

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        select(index + 1, { focus: true });
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        select(index - 1, { focus: true });
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(0, { focus: true });
      } else if (event.key === 'End') {
        event.preventDefault();
        select(GESTURES.length - 1, { focus: true });
      }
    });
  });

  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      autoOn = !autoOn;
      syncAuto();
    });
  }
  if (nextBtn) nextBtn.addEventListener('click', next);
  if (prevBtn) prevBtn.addEventListener('click', prev);

  section.addEventListener('pointerenter', () => {
    paused = true;
    syncAuto();
  });
  section.addEventListener('pointerleave', () => {
    paused = false;
    syncAuto();
  });
  section.addEventListener('focusin', () => {
    paused = true;
    syncAuto();
  });
  section.addEventListener('focusout', (event) => {
    if (section.contains(event.relatedTarget)) return;
    paused = false;
    syncAuto();
  });

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      visible = entry.isIntersecting;
      syncAuto();
    }
  }, { threshold: 0.3 });
  observer.observe(section);

  document.addEventListener('visibilitychange', syncAuto);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      autoOn = false;
      syncAuto();
    }
  });

  select(0);
}

/* ------------------------------------------------------------------ */
/* Live pose coach                                                     */
/* ------------------------------------------------------------------ */

const COACH_MAP = {
  Pointing: 'point',
  Pinch: 'pinch',
  Fist: 'fist',
  'Two fingers': 'scroll',
  'Open hand': 'open',
  'No hand': null,
  Paused: null,
  '—': null
};

function initCoach() {
  const readout = $('#poseReadout');
  const host = $('[data-coach-rig]');
  if (!readout || !host) return;

  const rig = new HandRig(host, { pose: 'point', cursor: false });
  const coach = host.closest('[data-coach]');
  let last = '';

  const sync = () => {
    const text = readout.textContent.trim();
    if (text === last) return;
    last = text;
    const pose = COACH_MAP[text];
    if (coach) coach.classList.toggle('is-off', !pose);
    if (pose) rig.setPose(pose);
  };

  const observer = new MutationObserver(sync);
  observer.observe(readout, { childList: true, characterData: true, subtree: true });
  sync();
}

function initStartRig() {
  const host = $('[data-start-rig]');
  if (host) new HandRig(host, { pose: 'open', cursor: false });
}

/* ------------------------------------------------------------------ */
/* Small interactive details                                           */
/* ------------------------------------------------------------------ */

function initPauseDemo() {
  const toggle = $('#sitePauseToggle');
  const state = $('#sitePauseState');
  const card = $('#featurePause');
  if (!toggle || !state || !card) return;

  toggle.addEventListener('click', () => {
    const paused = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(paused));
    card.classList.toggle('is-paused', paused);
    state.textContent = paused ? 'Paused on this site' : 'Active everywhere';
  });
}

function initInstallTabs() {
  const tabs = $$('[data-install-tab]');
  const panels = $$('[data-install-panel]');
  if (!tabs.length || !panels.length) return;

  const select = (id, { focus = false } = {}) => {
    tabs.forEach((tab) => {
      const active = tab.dataset.installTab === id;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    panels.forEach((panel) => {
      const active = panel.dataset.installPanel === id;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => select(tab.dataset.installTab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
      select(tabs[next].dataset.installTab, { focus: true });
    });
  });

  select(tabs[0].dataset.installTab);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

initHeader();
initReveal();
initHero();
initAtlas();
initCoach();
initStartRig();
initPauseDemo();
initInstallTabs();
