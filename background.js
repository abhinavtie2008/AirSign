'use strict';

const VERSION = '2.5.1';
const BUBBLE_KEY = 'airsignBubbleState';
const RESTORE_KEY = 'airsignRestorePending';
const PAUSED_KEY = 'airsignPausedSites';
const OFFSCREEN_URL = 'offscreen.html';
const SANDBOX_PATH = 'sandbox.html';

let cachedBubble;
let pausedSites = new Set();
let pausedRevision = 0;

function configureSidePanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn('AirSign side panel setup failed:', error));
}

chrome.runtime.onInstalled.addListener(async () => {
  configureSidePanel();
  try {
    await chrome.storage.session.remove([BUBBLE_KEY, RESTORE_KEY]);
    cachedBubble = null;
    if (chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
});
chrome.runtime.onStartup.addListener(configureSidePanel);
configureSidePanel();

function explain(error) {
  if (!error) return 'Unknown error';
  return error.message || String(error);
}

function isWebUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isSandboxUrl(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(SANDBOX_PATH));
}

function siteOrigin(url) {
  if (!isWebUrl(url)) return null;
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

function siteHost(url) {
  const origin = siteOrigin(url);
  if (!origin) return 'this site';
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch (_) {
    return origin;
  }
}

function isPausedUrl(url) {
  const origin = siteOrigin(url);
  return Boolean(origin && pausedSites.has(origin));
}

function normalizePausedSites(value) {
  const sites = new Set();
  if (!Array.isArray(value)) return sites;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    try {
      const url = new URL(entry);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry) {
        sites.add(entry);
      }
    } catch (_) {}
  }
  return sites;
}

async function loadPausedSites() {
  const revision = pausedRevision;
  try {
    const stored = await chrome.storage.local.get(PAUSED_KEY);
    if (revision !== pausedRevision) return;
    pausedSites = normalizePausedSites(stored && stored[PAUSED_KEY]);
  } catch (_) {
    if (revision === pausedRevision) pausedSites = new Set();
  }
}

function pausedStatusMessage(url) {
  return `Paused on ${siteHost(url)}. Open the panel to resume.`;
}

async function syncBubblePause() {
  await pausedReady;
  const state = await getBubble();
  if (!state || state.kind !== 'web') return;
  const paused = isPausedUrl(state.url);
  if (paused === Boolean(state.paused)) return;
  state.paused = paused;
  await setBubble(state);
  if (paused) {
    await sendToPage(state, { type: 'AIRSIGN_BUBBLE_STATUS', state: 'paused', message: pausedStatusMessage(state.url) });
  } else {
    await sendToPage(state, { type: 'AIRSIGN_BUBBLE_SHOW' });
    await sendToPage(state, { type: 'AIRSIGN_BUBBLE_STATUS', state: 'live' });
  }
}

const pausedReady = loadPausedSites();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PAUSED_KEY]) return;
  pausedRevision += 1;
  pausedSites = normalizePausedSites(changes[PAUSED_KEY].newValue);
  syncBubblePause();
});

async function getBubble() {
  if (cachedBubble !== undefined) return cachedBubble;
  try {
    const stored = await chrome.storage.session.get(BUBBLE_KEY);
    cachedBubble = stored && stored[BUBBLE_KEY] ? stored[BUBBLE_KEY] : null;
  } catch (_) {
    cachedBubble = null;
  }
  return cachedBubble;
}

async function setBubble(value) {
  cachedBubble = value || null;
  try {
    if (value) await chrome.storage.session.set({ [BUBBLE_KEY]: value });
    else await chrome.storage.session.remove(BUBBLE_KEY);
  } catch (_) {}
}

async function setRestorePending(value) {
  try {
    if (value) await chrome.storage.session.set({ [RESTORE_KEY]: true });
    else await chrome.storage.session.remove(RESTORE_KEY);
  } catch (_) {}
}

async function getRestorePending() {
  try {
    const stored = await chrome.storage.session.get(RESTORE_KEY);
    return Boolean(stored && stored[RESTORE_KEY]);
  } catch (_) {
    return false;
  }
}

function setBadge(text) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color: '#10b981' }).catch(() => {});
}

async function hasOffscreen() {
  try {
    return Boolean(chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument());
  } catch (_) {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'AirSign keeps camera-based hand tracking running while the side panel is minimized to the in-page camera bubble.'
  });
}

async function startOffscreen(settings) {
  await ensureOffscreen();
  let lastError = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({
        type: 'AIRSIGN_OFFSCREEN_START',
        settings: settings || {}
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120));
      continue;
    }
    if (reply && reply.ok) return;
    if (reply && reply.error) throw new Error(reply.error);
    lastError = new Error('The background tracker is still starting.');
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw lastError || new Error('The background tracker did not start.');
}

async function stopOffscreen() {
  if (!(await hasOffscreen())) return;
  try {
    await chrome.runtime.sendMessage({ type: 'AIRSIGN_OFFSCREEN_STOP' });
  } catch (_) {}
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {}
}

async function sendToPage(state, message) {
  if (!state) return;
  try {
    if (state.kind === 'sandbox') {
      await chrome.runtime.sendMessage(message);
    } else {
      await chrome.tabs.sendMessage(state.tabId, message);
    }
  } catch (_) {}
}

async function ensureBubbleScripts(state) {
  if (!state || state.kind === 'sandbox') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      files: ['content.js', 'bubble.js']
    });
  } catch (error) {
    throw new Error('This page cannot host the AirSign bubble. Switch to a normal http:// or https:// page.');
  }
}

async function showBubble(state) {
  await ensureBubbleScripts(state);
  await sendToPage(state, { type: 'AIRSIGN_BUBBLE_SHOW' });
}

async function forwardFrame(payload) {
  await pausedReady;
  const state = await getBubble();
  if (!state) return;
  if (state.paused || (state.kind === 'web' && isPausedUrl(state.url))) return;
  sendToPage(state, { type: 'AIRSIGN_FRAME', payload });
}

async function forwardPreview(message) {
  const state = await getBubble();
  if (!state) return;
  sendToPage(state, {
    type: 'AIRSIGN_BUBBLE_PREVIEW',
    dataUrl: message.dataUrl,
    pose: message.pose,
    handPresent: message.handPresent
  });
}

async function forwardStatus(message) {
  await pausedReady;
  const state = await getBubble();
  if (!state) return;
  const paused = state.paused || (state.kind === 'web' && isPausedUrl(state.url));
  if (paused && message.state !== 'error') return;
  sendToPage(state, {
    type: 'AIRSIGN_BUBBLE_STATUS',
    state: message.state,
    message: message.message || ''
  });
}

async function enterBubble(message) {
  const tab = message.tab;
  if (!tab || !Number.isInteger(tab.tabId)) throw new Error('No page is selected for the bubble.');
  const sandbox = isSandboxUrl(tab.url);
  if (!sandbox && !isWebUrl(tab.url)) {
    throw new Error('This page cannot host the AirSign bubble. Switch to a normal website.');
  }

  await pausedReady;
  if (await getBubble()) await stopBubble({ hide: true, notify: false });

  const state = {
    tabId: tab.tabId,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    kind: sandbox ? 'sandbox' : 'web',
    url: tab.url,
    title: tab.title || '',
    settings: message.settings || {},
    paused: !sandbox && isPausedUrl(tab.url),
    startedAt: Date.now()
  };
  await setBubble(state);
  await setRestorePending(false);

  try {
    await startOffscreen(message.settings || {});
    await showBubble(state);
    if (state.paused) {
      await sendToPage(state, { type: 'AIRSIGN_BUBBLE_STATUS', state: 'paused', message: pausedStatusMessage(state.url) });
    }
  } catch (error) {
    await stopOffscreen();
    await setBubble(null);
    throw error;
  }

  setBadge('ON');
  return { ok: true };
}

async function stopBubble({ hide = true, notify = true } = {}) {
  const state = await getBubble();
  if (state && hide) await sendToPage(state, { type: 'AIRSIGN_BUBBLE_HIDE' });
  await setBubble(null);
  await setRestorePending(false);
  await stopOffscreen();
  setBadge('');
  if (notify) chrome.runtime.sendMessage({ type: 'AIRSIGN_BUBBLE_STOPPED' }).catch(() => {});
  return { ok: true };
}

async function exitBubble(opening) {
  const state = await getBubble();
  if (!state) {
    setBadge('');
    return { ok: true, restored: false };
  }

  // Mark the handoff before opening so a freshly loaded panel always knows to
  // take tracking back, even if it becomes visible before this call returns.
  await setRestorePending(true);

  let opened = false;
  try {
    opened = opening
      ? await opening
      : await chrome.sidePanel.open({ windowId: state.windowId ?? chrome.windows.WINDOW_ID_CURRENT }).then(() => true);
  } catch (error) {
    console.warn('AirSign could not open the side panel:', error);
  }

  if (!opened) {
    return {
      ok: false,
      error: 'Your browser did not open the side panel. Click the AirSign toolbar icon to restore it.'
    };
  }

  await sendToPage(state, { type: 'AIRSIGN_BUBBLE_HIDE' });
  await setBubble(null);
  await stopOffscreen();
  setBadge('');
  chrome.runtime.sendMessage({ type: 'AIRSIGN_RESTORE_PANEL' }).catch(() => {});
  return { ok: true, restored: true };
}

async function panelTakeover(windowId) {
  const state = await getBubble();
  const pending = await getRestorePending();
  if (state && Number.isInteger(windowId) && Number.isInteger(state.windowId) && state.windowId !== windowId) {
    return { restore: false, activeElsewhere: true };
  }
  if (state) {
    await sendToPage(state, { type: 'AIRSIGN_BUBBLE_HIDE' });
    await setBubble(null);
    await stopOffscreen();
  }
  await setRestorePending(false);
  setBadge('');
  return { restore: Boolean(state) || pending };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.source === 'offscreen') {
    if (message.type === 'AIRSIGN_TRACKER_FRAME') {
      forwardFrame(message.payload);
    } else if (message.type === 'AIRSIGN_BUBBLE_PREVIEW') {
      forwardPreview(message);
    } else if (message.type === 'AIRSIGN_TRACKER_STATUS') {
      forwardStatus(message);
    }
    return;
  }

  if (message.type === 'AIRSIGN_ENTER_BUBBLE') {
    enterBubble(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: explain(error) }));
    return true;
  }

  if (message.type === 'AIRSIGN_BUBBLE_HELLO') {
    (async () => {
      const state = await getBubble();
      if (!state) {
        sendResponse({ show: false, version: VERSION });
        return;
      }
      const fromSandbox = isSandboxUrl(sender.url);
      const show = fromSandbox
        ? state.kind === 'sandbox'
        : Boolean(sender.tab && sender.tab.id === state.tabId);
      sendResponse({ show, version: VERSION });
    })();
    return true;
  }

  if (message.type === 'AIRSIGN_BUBBLE_STOP') {
    stopBubble({ hide: true }).then(sendResponse);
    return true;
  }

  if (message.type === 'AIRSIGN_BUBBLE_EXIT') {
    // sidePanel.open() needs a user gesture, so start it synchronously while
    // the click's synthesized gesture is still active instead of after awaits.
    const windowId = sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : null;
    const opening = windowId === null
      ? null
      : chrome.sidePanel.open({ windowId }).then(() => true, (error) => {
        console.warn('AirSign could not open the side panel:', error);
        return false;
      });
    exitBubble(opening).then(sendResponse);
    return true;
  }

  if (message.type === 'AIRSIGN_BUBBLE_VISIBILITY') {
    (async () => {
      const state = await getBubble();
      if (!state) {
        sendResponse({ ok: true });
        return;
      }
      try {
        if (message.visible) {
          await ensureOffscreen();
          const reply = await chrome.runtime.sendMessage({ type: 'AIRSIGN_OFFSCREEN_RESUME' });
          setBadge(reply && reply.ok ? 'ON' : 'II');
          if (reply && !reply.ok) {
            forwardStatus({ state: 'error', message: reply.error || 'The camera could not resume.' });
          }
        } else {
          await chrome.runtime.sendMessage({ type: 'AIRSIGN_OFFSCREEN_PAUSE' }).catch(() => {});
          setBadge('II');
        }
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'AIRSIGN_PANEL_TAKEOVER') {
    panelTakeover(message.windowId).then(sendResponse);
    return true;
  }

  if (message.type === 'AIRSIGN_PANEL_STOP_BUBBLE') {
    stopBubble({ hide: true }).then(sendResponse);
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getBubble();
  if (state && state.tabId === tabId) {
    await stopBubble({ hide: false });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const state = await getBubble();
  if (!state || state.tabId !== tabId) return;
  await pausedReady;

  if (changeInfo.url && !changeInfo.status) {
    state.url = changeInfo.url;
    await setBubble(state);
    await syncBubblePause();
    return;
  }

  if (changeInfo.status === 'complete') {
    const url = tab.url || state.url;
    if (state.kind === 'sandbox' ? !isSandboxUrl(url) : !isWebUrl(url)) {
      await stopBubble({ hide: false });
      return;
    }
    state.url = url;
    state.title = tab.title || state.title;
    state.paused = state.kind === 'web' && isPausedUrl(url);
    await setBubble(state);
    await sendToPage(state, { type: 'AIRSIGN_BUBBLE_SHOW' });
    await sendToPage(state, state.paused
      ? { type: 'AIRSIGN_BUBBLE_STATUS', state: 'paused', message: pausedStatusMessage(url) }
      : { type: 'AIRSIGN_BUBBLE_STATUS', state: 'live' });
  }
});
