import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  sleep,
  freePort,
  findBrowser,
  launchBrowser,
  waitForEndpoint,
  getJson,
  waitFor,
  waitForTarget,
  Cdp,
  attachTarget,
  openTab,
  activateTab,
  clickAt,
  dragBy,
  killBrowser
} from './harness.mjs';
import { pointHand, pinchHand, fistHand, scrollHand, openHand } from '../landmarks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const artifacts = path.join(root, 'tests', 'e2e', 'artifacts');
const REACH = { x0: 0.16, x1: 0.84, y0: 0.1, y1: 0.72 };

fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const pageHtml = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:32px;font:16px/1.5 system-ui,sans-serif}button{font:inherit;padding:12px 22px}</style>
</head><body><h1>${title}</h1><button id="plus" type="button">+1</button> <span id="count">0</span>
<div style="height:3000px"></div></body></html>`;

function startServer() {
  const server = createServer((request, response) => {
    const title = request.url.startsWith('/b') ? 'AirSign E2E B' : 'AirSign E2E A';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageHtml(title));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const panelState = (panel) => panel.eval(`({
  label: document.getElementById('startLabel')?.textContent || '',
  message: document.getElementById('message')?.textContent || '',
  tracking: document.getElementById('trackingStatus')?.textContent || '',
  camera: document.getElementById('cameraState')?.textContent || '',
  bubbleHidden: document.getElementById('bubbleBtn')?.hidden !== false,
  target: document.getElementById('targetTitle')?.textContent || ''
})`);

const waitForPanelRunning = (panel, timeout = 90000) => waitFor(async () => {
  const state = await panelState(panel);
  if (state.label === 'AirSign running') return state;
  if (state.message.startsWith('AirSign could not start') || state.message.startsWith('Camera setup failed')) {
    throw new Error(`AirSign failed to start: ${state.message}`);
  }
  return null;
}, { timeout, label: 'tracking to start' });

const waitForPanelIdle = (panel, timeout = 15000) => waitFor(async () => {
  const state = await panelState(panel);
  return state.label === 'Start AirSign' && state.camera === 'CAMERA OFF' ? state : null;
}, { timeout, label: 'panel to return to idle' });

const bubbleState = (sandbox) => sandbox.eval(`(() => {
  const bubble = window.__airsignBubble;
  if (!bubble) return null;
  return {
    version: bubble.version,
    visible: bubble.visible,
    pose: bubble.pose,
    status: bubble.status,
    hasPreview: bubble.hasPreview,
    position: bubble.position,
    buttons: bubble.buttons
  };
})()`);

const setHand = (sandbox, landmarks) => sandbox.eval(
  `chrome.runtime.sendMessage({ type: 'AIRSIGN_TEST_HAND', landmarks: ${JSON.stringify(landmarks)} }).then((reply) => Boolean(reply && reply.ok))`
);

const offscreenPing = (sandbox) => sandbox.eval(
  `chrome.runtime.sendMessage({ type: 'AIRSIGN_OFFSCREEN_PING' }).catch((error) => ({ error: error.message }))`
);

const hasTarget = async (port, predicate) => (await getJson(port, '/json/list')).some(predicate);

const waitForNoTarget = (port, predicate, label, timeout = 10000) => waitFor(
  () => hasTarget(port, predicate).then((found) => !found),
  { timeout, label }
);

const collectErrors = (targets) => {
  const exceptions = [];
  const consoleErrors = [];
  for (const [label, cdp] of targets) {
    if (!cdp) continue;
    for (const error of cdp.exceptions) exceptions.push(`${label}: ${error}`);
    for (const error of cdp.consoleErrors) consoleErrors.push(`${label}: ${error}`);
  }
  return { exceptions, consoleErrors };
};

async function openSidePanel(browser, port, extensionId) {
  const bootstrap = await openTab(
    browser,
    port,
    `chrome-extension://${extensionId}/sidepanel.html`,
    'panel bootstrap'
  );
  const windowId = await bootstrap.cdp.eval('chrome.windows.getCurrent().then((window) => window.id)');
  const opened = await bootstrap.cdp.eval(
    `chrome.sidePanel.open({ windowId: ${windowId} }).then(() => 'ok').catch((error) => 'error: ' + error.message)`,
    { userGesture: true }
  );
  if (opened !== 'ok') throw new Error(`Could not open the side panel: ${opened}`);
  const target = await waitForTarget(
    port,
    (candidate) => candidate.type === 'page' && candidate.url.includes('sidepanel.html') && candidate.id !== bootstrap.targetId,
    'real side panel'
  );
  const panel = await attachTarget(target, 'panel');
  await browser.send('Target.closeTarget', { targetId: bootstrap.targetId });
  bootstrap.cdp.close();
  await sleep(500);
  return panel;
}

async function aimAt(sandbox, selector) {
  const point = await sandbox.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    return { nx: (rect.left + rect.width / 2) / innerWidth, ny: (rect.top + rect.height / 2) / innerHeight };
  })()`);
  if (!point) throw new Error(`Missing sandbox target ${selector}`);
  await sleep(250);
  return {
    tipX: 1 - (REACH.x0 + point.nx * (REACH.x1 - REACH.x0)),
    yOffset: REACH.y0 + point.ny * (REACH.y1 - REACH.y0) - 0.3
  };
}

let chrome = null;
let browser = null;
let sandbox = null;
let panel = null;
let restoredPanel = null;
let offscreen = null;
let pageOffscreen = null;
let pageCdp = null;
let worker = null;
let profile = null;
let serverA = null;
let serverB = null;

try {
  serverA = await startServer();
  serverB = await startServer();
  const originA = `http://127.0.0.1:${serverA.address().port}`;
  const originB = `http://127.0.0.1:${serverB.address().port}`;

  const executable = findBrowser();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'airsign-e2e-'));
  const port = await freePort();
  chrome = launchBrowser({ executable, port, profileDir: profile });
  const info = await waitForEndpoint(port, chrome);
  console.log(`browser: ${info.Browser}`);

  browser = await Cdp.connect(info.webSocketDebuggerUrl, 'browser');
  const loaded = await browser.send('Extensions.loadUnpacked', { path: root }).catch((error) => {
    throw new Error(`Could not load the unpacked extension: ${error.message}. Chrome 125+ is required; set AIRSIGN_CHROME to a supported binary.`);
  });
  const extensionId = loaded.id;
  check('the extension loads unpacked', /^[a-p]{32}$/.test(extensionId), extensionId);

  const workerTarget = await waitForTarget(
    port,
    (target) => target.type === 'service_worker' && target.url.includes('background.js'),
    'service worker',
    8000
  ).catch(() => null);
  if (workerTarget) worker = await attachTarget(workerTarget, 'service worker');

  const sandboxTab = await openTab(
    browser,
    port,
    `chrome-extension://${extensionId}/sandbox.html`,
    'sandbox'
  );
  sandbox = sandboxTab.cdp;
  await sandbox.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const bridgeVersion = await waitFor(
    () => sandbox.eval('window.__airsignBridge && window.__airsignBridge.version'),
    { timeout: 10000, label: 'sandbox bridge' }
  );
  check('the page bridge reports the manifest version', bridgeVersion === manifest.version, `${bridgeVersion} vs ${manifest.version}`);

  panel = await openSidePanel(browser, port, extensionId);
  const idle = await waitFor(async () => {
    const state = await panelState(panel);
    return state.label === 'Start AirSign' ? state : null;
  }, { timeout: 15000, label: 'panel idle state' });
  check('the side panel opens', idle.bubbleHidden === true && idle.camera === 'CAMERA OFF', `${idle.label}, ${idle.camera}`);

  await panel.eval(`document.getElementById('dwell').click()`);
  await panel.eval(`(() => { const input = document.getElementById('dwellMs'); input.value = '1200'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const dwellSetting = await waitFor(async () => {
    const stored = await panel.eval(`chrome.storage.local.get('airsignSettings').then((value) => value.airsignSettings || null)`);
    return stored && stored.dwell === true && stored.dwellMs === 1200 ? stored : null;
  }, { timeout: 5000, label: 'dwell setting to persist' });
  check('dwell can be enabled from the panel', dwellSetting.dwell === true && dwellSetting.dwellMs === 1200, `${dwellSetting.dwellMs} ms`);
  await panel.screenshot(path.join(artifacts, 'panel-idle.png'));

  await activateTab(browser, sandboxTab.targetId);
  const targetFollowed = await waitFor(async () => {
    const state = await panelState(panel);
    return state.target === 'AirSign test page' ? state : null;
  }, { timeout: 10000, label: 'panel to follow the test page' });
  check('the panel follows the active tab', targetFollowed.target === 'AirSign test page', targetFollowed.target);

  await panel.eval(`document.getElementById('startBtn').click()`);
  const running = await waitForPanelRunning(panel);
  check('tracking starts with the fake camera', running.camera === 'CAMERA LIVE' && !running.bubbleHidden, `${running.camera}, ${running.tracking}`);
  await panel.screenshot(path.join(artifacts, 'panel-running.png'));

  await activateTab(browser, sandboxTab.targetId);
  await sleep(300);
  await panel.eval(`document.getElementById('bubbleBtn').click()`).catch(() => {});
  await waitForNoTarget(port, (target) => target.url.includes('sidepanel.html'), 'side panel to close', 30000);
  const offscreenTarget = await waitForTarget(port, (target) => target.url.endsWith('/offscreen.html'), 'offscreen tracker');
  offscreen = await attachTarget(offscreenTarget, 'offscreen');

  const bubbleUp = await waitFor(async () => {
    const state = await bubbleState(sandbox).catch(() => null);
    return state && state.visible ? state : null;
  }, { timeout: 20000, label: 'camera bubble' });
  check('minimizing shows the camera bubble', bubbleUp.version === manifest.version && bubbleUp.visible, `v${bubbleUp.version}`);
  const preview = await waitFor(async () => {
    const state = await bubbleState(sandbox);
    return state.hasPreview ? state : null;
  }, { timeout: 20000, label: 'bubble preview frames' });
  check('the bubble receives camera preview frames', preview.hasPreview, preview.status || 'live');
  await sandbox.screenshot(path.join(artifacts, 'bubble-live.png'));

  const aimPlus = await aimAt(sandbox, '#plus');
  for (let frame = 0; frame < 5; frame += 1) {
    await setHand(sandbox, pointHand(aimPlus));
    await sleep(90);
  }
  await waitFor(
    () => sandbox.eval(`window.__airsignBridge.state.pose === 'point' && window.__airsignBridge.state.visible`),
    { timeout: 8000, label: 'page bridge pointer' }
  );
  const dwelled = await waitFor(async () => {
    const value = await sandbox.eval(`document.getElementById('count').textContent`);
    return value === '1' ? value : null;
  }, { timeout: 7000, label: 'dwell click' });
  check('resting a point over a control fires a dwell click', dwelled === '1', 'count 0 -> 1');

  // Release before capturing: a slow screenshot can block the renderer past
  // the tracker's 350 ms loss window, which re-arms dwell while the hand is
  // still and causes a second click when tracking returns.
  for (let frame = 0; frame < 4; frame += 1) {
    await setHand(sandbox, openHand());
    await sleep(90);
  }
  await setHand(sandbox, null);
  await sleep(400);
  await sandbox.screenshot(path.join(artifacts, 'bubble-dwell.png'));

  const beforeClick = Number(await sandbox.eval(`document.getElementById('count').textContent`));
  for (let frame = 0; frame < 3; frame += 1) {
    await setHand(sandbox, pointHand(aimPlus));
    await sleep(90);
  }
  await waitFor(
    () => sandbox.eval(`window.__airsignBridge.state.pose === 'point'`),
    { timeout: 8000, label: 'pointer re-armed over the control' }
  );
  for (let frame = 0; frame < 4; frame += 1) {
    await setHand(sandbox, pinchHand({ ...aimPlus, gap: 0.015 }));
    await sleep(90);
  }
  await waitFor(async () => {
    const value = Number(await sandbox.eval(`document.getElementById('count').textContent`));
    return value !== beforeClick ? value : null;
  }, { timeout: 8000, label: 'synthetic pinch click' });
  await sleep(400);
  const settledClick = Number(await sandbox.eval(`document.getElementById('count').textContent`));
  check('a synthetic pinch adds exactly one click', settledClick === beforeClick + 1, `count ${beforeClick} -> ${settledClick}`);
  await sandbox.screenshot(path.join(artifacts, 'bubble-click.png'));

  for (let frame = 0; frame < 4; frame += 1) {
    await setHand(sandbox, openHand());
    await sleep(90);
  }
  await setHand(sandbox, null);
  await sleep(300);

  const aimSlider = await aimAt(sandbox, '#slider');
  for (let frame = 0; frame < 5; frame += 1) {
    await setHand(sandbox, pointHand(aimSlider));
    await sleep(90);
  }
  await waitFor(
    () => sandbox.eval(`window.__airsignBridge.state.pose === 'point'`),
    { timeout: 8000, label: 'pointer over the slider' }
  );

  // A folded fist exposes a different index tip than a point. Pin the fist's
  // folded tip to the aim position so the debounce frames before the drag
  // pose starts do not move the cursor off the slider.
  const fistAim = {
    xOffset: aimSlider.tipX - 0.44,
    yOffset: aimSlider.yOffset - 0.3
  };
  for (let frame = 0; frame < 3; frame += 1) {
    await setHand(sandbox, fistHand(fistAim));
    await sleep(90);
  }
  await waitFor(
    () => sandbox.eval(`window.__airsignBridge.state.pose === 'drag'`),
    { timeout: 8000, label: 'drag pose' }
  );
  for (let step = 1; step <= 5; step += 1) {
    await setHand(sandbox, fistHand({ ...fistAim, xOffset: fistAim.xOffset - step * 0.03 }));
    await sleep(120);
  }
  const sliderValue = await waitFor(async () => {
    const value = await sandbox.eval(`document.getElementById('sliderValue').textContent`);
    return value !== '50%' ? value : null;
  }, { timeout: 8000, label: 'slider to move' });
  check('a fist drag moves the slider', Number.parseInt(sliderValue, 10) > 50, sliderValue);
  await sandbox.screenshot(path.join(artifacts, 'bubble-drag.png'));

  for (let frame = 0; frame < 4; frame += 1) {
    await setHand(sandbox, openHand());
    await sleep(90);
  }
  await setHand(sandbox, null);
  await sleep(300);
  await sandbox.eval(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(200);

  for (let frame = 0; frame < 3; frame += 1) {
    await setHand(sandbox, scrollHand({ yOffset: 0 }));
    await sleep(90);
  }
  await waitFor(
    () => sandbox.eval(`window.__airsignBridge.state.pose === 'scroll'`),
    { timeout: 8000, label: 'scroll pose' }
  );
  for (let step = 1; step <= 8; step += 1) {
    await setHand(sandbox, scrollHand({ yOffset: step * 0.03 }));
    await sleep(100);
  }
  const scrolled = await waitFor(
    () => sandbox.eval(`window.scrollY > 80 ? window.scrollY : 0`),
    { timeout: 8000, label: 'two-finger scroll' }
  );
  check('a two-finger gesture scrolls the page', scrolled > 80, `${Math.round(scrolled)} px`);
  await sandbox.screenshot(path.join(artifacts, 'bubble-scroll.png'));

  for (let frame = 0; frame < 4; frame += 1) {
    await setHand(sandbox, openHand());
    await sleep(90);
  }
  await setHand(sandbox, null);
  await sleep(400);

  const bubbleBeforeDrag = await bubbleState(sandbox);
  const startX = bubbleBeforeDrag.position.left + bubbleBeforeDrag.position.width / 2;
  const startY = bubbleBeforeDrag.position.top + 26;
  await dragBy(sandbox, startX, startY, -180, -140);
  const bubbleAfterDrag = await bubbleState(sandbox);
  const moved = Math.hypot(
    bubbleAfterDrag.position.left - bubbleBeforeDrag.position.left,
    bubbleAfterDrag.position.top - bubbleBeforeDrag.position.top
  );
  check('the bubble can be dragged', moved > 100, `${Math.round(moved)} px`);

  const otherTab = await openTab(browser, port, 'about:blank', 'background tab');
  await activateTab(browser, otherTab.targetId);
  const paused = await waitFor(async () => {
    const reply = await offscreenPing(sandbox);
    return reply && reply.paused ? reply : null;
  }, { timeout: 10000, label: 'tracker pause while hidden' });
  const pausedBubble = await waitFor(async () => {
    const state = await bubbleState(sandbox);
    return state && state.status === 'Paused while this tab is hidden.' ? state : null;
  }, { timeout: 5000, label: 'paused bubble status' });
  check('hiding the target tab pauses tracking', pausedBubble.status === 'Paused while this tab is hidden.', pausedBubble.status);

  await activateTab(browser, sandboxTab.targetId);
  const resumed = await waitFor(async () => {
    const reply = await offscreenPing(sandbox);
    return reply && reply.running && !reply.paused ? reply : null;
  }, { timeout: 10000, label: 'tracker resume when visible' });
  check('returning to the tab resumes tracking', resumed.running === true && resumed.paused === false, JSON.stringify(resumed));
  await browser.send('Target.closeTarget', { targetId: otherTab.targetId });
  otherTab.cdp.close();

  const bubbleButtons = (await bubbleState(sandbox)).buttons;
  await clickAt(sandbox, bubbleButtons.panel.x, bubbleButtons.panel.y);
  const restoredTarget = await waitForTarget(
    port,
    (target) => target.type === 'page' && target.url.includes('sidepanel.html'),
    'restored side panel',
    20000
  );
  restoredPanel = await attachTarget(restoredTarget, 'restored panel');
  const restored = await waitForPanelRunning(restoredPanel, 30000);
  const bubbleHidden = await waitFor(async () => {
    const state = await bubbleState(sandbox).catch(() => null);
    return !state || !state.visible ? true : null;
  }, { timeout: 10000, label: 'bubble to hide' });
  await waitForNoTarget(port, (target) => target.url.endsWith('/offscreen.html'), 'offscreen tracker to close');
  check('the bubble Panel button restores a running panel', restored.label === 'AirSign running' && bubbleHidden === true, restored.label);
  await restoredPanel.screenshot(path.join(artifacts, 'panel-restored.png'));

  await restoredPanel.eval(`document.getElementById('stopBtn').click()`);
  await waitForPanelIdle(restoredPanel);
  await waitForNoTarget(port, (target) => target.url.endsWith('/offscreen.html'), 'tracker to close after stop');
  const stoppedCursor = await waitFor(
    () => sandbox.eval('window.__airsignBridge.state.visible === false'),
    { timeout: 8000, label: 'cursor overlay to hide' }
  );
  check('stopping from the panel tears everything down', stoppedCursor === true, 'panel idle, tracker closed, cursor hidden');
  await restoredPanel.screenshot(path.join(artifacts, 'panel-stopped.png'));

  const { targetId: pageTargetId } = await browser.send('Target.createTarget', { url: `${originA}/` });
  const pageTarget = await waitForTarget(port, (target) => target.id === pageTargetId, 'E2E page A');
  pageCdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl, 'E2E page');
  const pageContexts = new Map();
  pageCdp.on('Runtime.executionContextCreated', ({ context }) => pageContexts.set(context.id, context));
  pageCdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => pageContexts.delete(executionContextId));
  pageCdp.on('Runtime.executionContextsCleared', () => pageContexts.clear());
  await pageCdp.enable();
  await activateTab(browser, pageTargetId);
  const pageTab = await sandbox.eval(`chrome.tabs.query({ url: ${JSON.stringify(`${originA}/*`)} }).then((tabs) => tabs[0] ? { id: tabs[0].id } : null)`);
  if (!pageTab) throw new Error('Could not find the HTTP test tab through chrome.tabs');
  await waitFor(async () => {
    const state = await panelState(restoredPanel);
    return state.target === 'AirSign E2E A' ? state : null;
  }, { timeout: 10000, label: 'panel to follow the HTTP page' });

  const isolate = () => [...pageContexts.values()]
    .filter((context) => String(context.origin).startsWith(`chrome-extension://${extensionId}`) && context.auxData && context.auxData.isDefault !== true)
    .pop();
  const evalPage = async (expression) => {
    const context = isolate();
    if (!context) throw new Error('content script context unavailable');
    return pageCdp.eval(expression, { contextId: context.id });
  };
  const pageState = () => evalPage(`(() => {
    const bubble = window.__airsignBubble;
    const bridge = window.__airsignBridge;
    return {
      href: location.href,
      bridge: Boolean(bridge),
      cursor: bridge ? bridge.state.visible : false,
      bubble: bubble ? {
        version: bubble.version,
        visible: bubble.visible,
        status: bubble.status,
        position: bubble.position,
        buttons: bubble.buttons
      } : null
    };
  })()`);
  const waitForPageBubble = (predicate, label, timeout = 25000) => waitFor(async () => {
    const state = await pageState().catch(() => null);
    return state && state.bubble && predicate(state) ? state : null;
  }, { timeout, label });
  const waitForCursor = (visible) => waitFor(async () => {
    const state = await pageState().catch(() => null);
    return state && state.bridge && state.cursor === visible ? state : null;
  }, { timeout: 8000, label: `cursor ${visible ? 'shown' : 'hidden'} on the E2E page` });

  await restoredPanel.eval(`document.getElementById('startBtn').click()`);
  const pageRunning = await waitForPanelRunning(restoredPanel, 90000);
  check('tracking can start again on a normal HTTP page', pageRunning.label === 'AirSign running', pageRunning.tracking);
  await activateTab(browser, pageTargetId);
  await sleep(300);
  await restoredPanel.eval(`document.getElementById('bubbleBtn').click()`).catch(() => {});
  await waitForNoTarget(port, (target) => target.url.includes('sidepanel.html'), 'side panel to close on HTTP page', 30000);
  const pageOffscreenTarget = await waitForTarget(port, (target) => target.url.endsWith('/offscreen.html'), 'offscreen tracker for HTTP page');
  pageOffscreen = await attachTarget(pageOffscreenTarget, 'offscreen HTTP');
  const pageBubbleUp = await waitForPageBubble((state) => state.bubble.visible && state.bridge, 'bubble on the HTTP page');
  check('the bubble attaches to a normal HTTP page', pageBubbleUp.bubble.version === manifest.version && pageBubbleUp.bubble.visible, pageBubbleUp.href);
  await pageCdp.screenshot(path.join(artifacts, 'page-bubble.png'));

  // Keep a synthetic hand streaming so cursor assertions follow the tracker
  // instead of racing the 350 ms frame-loss timeout.
  await setHand(sandbox, pointHand({ tipX: 0.45, yOffset: -0.05 }));

  await sandbox.eval(`chrome.storage.local.set({ airsignPausedSites: [${JSON.stringify(originA)}] }).then(() => true)`);
  const sitePaused = await waitForPageBubble(
    (state) => state.bubble.status.startsWith('Paused on 127.0.0.1:'),
    'per-site pause'
  );
  const pausedPage = await waitForCursor(false);
  check('pausing the origin pauses the bubble', sitePaused.bubble.status === `Paused on 127.0.0.1:${serverA.address().port}. Open the panel to resume.` && pausedPage.cursor === false, sitePaused.bubble.status);
  await pageCdp.screenshot(path.join(artifacts, 'page-paused.png'));

  await sandbox.eval(`chrome.tabs.update(${pageTab.id}, { url: ${JSON.stringify(`${originB}/`)} }).then(() => true)`);
  await waitFor(() => pageCdp.eval('location.href').then((href) => href.startsWith(originB) ? href : null), { timeout: 15000, label: 'navigation to the second origin' });
  const navigated = await waitForPageBubble(
    (state) => state.bubble.visible && state.bubble.status === '' && state.bridge,
    'bubble after navigation'
  );
  await waitForCursor(true);
  check('the bubble survives navigation to another origin', navigated.href.startsWith(originB), navigated.href);
  await pageCdp.screenshot(path.join(artifacts, 'page-navigated.png'));

  await sandbox.eval(`chrome.tabs.update(${pageTab.id}, { url: ${JSON.stringify(`${originA}/`)} }).then(() => true)`);
  await waitFor(() => pageCdp.eval('location.href').then((href) => href.startsWith(originA) ? href : null), { timeout: 15000, label: 'navigation back to the paused origin' });
  const pausedAgain = await waitForPageBubble(
    (state) => state.bubble.visible && state.bubble.status.startsWith('Paused on 127.0.0.1:'),
    'per-site pause after navigating back'
  );
  check('navigating back to the paused origin pauses again', pausedAgain.bubble.status.includes(`:${serverA.address().port}.`), pausedAgain.bubble.status);

  await sandbox.eval(`chrome.storage.local.set({ airsignPausedSites: [] }).then(() => true)`);
  const resumedPage = await waitForPageBubble(
    (state) => state.bubble.visible && state.bubble.status === '' && state.bridge,
    'resume after clearing the pause'
  );
  await waitForCursor(true);
  check('clearing the pause resumes the bubble', resumedPage.bubble.status === '', 'live again');

  const pageButtons = (await pageState()).bubble.buttons;
  await clickAt(pageCdp, pageButtons.panel.x, pageButtons.panel.y);
  const finalPanelTarget = await waitForTarget(
    port,
    (target) => target.type === 'page' && target.url.includes('sidepanel.html'),
    'side panel restored from the HTTP page',
    20000
  );
  restoredPanel = await attachTarget(finalPanelTarget, 'final panel');
  await waitForPanelRunning(restoredPanel, 30000);
  await restoredPanel.eval(`document.getElementById('stopBtn').click()`);
  await waitForPanelIdle(restoredPanel);
  await waitForNoTarget(port, (target) => target.url.endsWith('/offscreen.html'), 'tracker to close at the end');
  const finalCursor = await waitFor(
    () => evalPage('window.__airsignBridge.state.visible === false'),
    { timeout: 8000, label: 'final cursor hidden' }
  );
  check('the HTTP session stops cleanly from the panel', finalCursor === true, 'idle panel, cursor hidden');
  await pageCdp.screenshot(path.join(artifacts, 'final.png'));

  const errors = collectErrors([
    ['sandbox', sandbox],
    ['panel', panel],
    ['restored panel', restoredPanel],
    ['offscreen', offscreen],
    ['offscreen HTTP', pageOffscreen],
    ['page', pageCdp],
    ['service worker', worker]
  ]);
  check('no uncaught exceptions were raised', errors.exceptions.length === 0, errors.exceptions.join(' | '));
  if (errors.consoleErrors.length) {
    console.log('console errors (not fatal):', errors.consoleErrors.join(' | '));
  }
} catch (error) {
  check('the E2E suite ran to completion', false, error.stack || error.message);
  for (const [name, target] of [['sandbox', sandbox], ['panel', panel], ['restored panel', restoredPanel], ['page', pageCdp]]) {
    if (!target) continue;
    await target.screenshot(path.join(artifacts, `failure-${name.replaceAll(' ', '-')}.png`)).catch(() => {});
  }
} finally {
  for (const target of [sandbox, panel, restoredPanel, offscreen, pageOffscreen, pageCdp, worker, browser]) {
    try { target?.close(); } catch (_) {}
  }
  if (chrome?.child) killBrowser(chrome.child);
  serverA?.close();
  serverB?.close();
  if (profile) {
    await sleep(600);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (_) {}
  }
  const failures = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  console.log(`screenshots: ${artifacts}`);
  process.exit(failures === 0 ? 0 : 1);
}
