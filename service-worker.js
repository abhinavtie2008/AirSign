'use strict';

// AirSign routes gesture frames from the camera tab to whichever ordinary
// webpage the user most recently activated. The tracker tab itself is ignored.
const VERSION = '1.0.9';
const STORAGE_KEY = 'airsignSessionV109';
let state = {
  sessionId: null,
  trackerTabId: null,
  sourceType: null,
  initialTargetTabId: null,
  targetTabId: null,
  targetTitle: '',
  targetUrl: ''
};
let hydration = null;
const bridgePromises = new Map();
const bridgeFailures = new Map();

async function hydrate() {
  if (!hydration) {
    hydration = chrome.storage.session.get(STORAGE_KEY).then((stored) => {
      const saved = stored && stored[STORAGE_KEY];
      if (saved && typeof saved === 'object') state = { ...state, ...saved };
      return state;
    }).catch((error) => {
      console.warn('AirSign could not restore the session state:', error);
      return state;
    });
  }
  return hydration;
}

async function persist() {
  try { await chrome.storage.session.set({ [STORAGE_KEY]: state }); }
  catch (error) { console.warn('AirSign could not save its session state:', error); }
}

function isWebUrl(url) { return typeof url === 'string' && /^https?:\/\//i.test(url); }
function isSidePanelSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  try { return new URL(sender.url).pathname.endsWith('/sidepanel.html'); } catch (_) { return false; }
}
function explain(error) {
  if (!error) return 'Unknown error';
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return `${name}: ${message}`;
}

async function pingBridge(tabId) {
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'AIRSIGN_PING' });
  if (!reply || reply.ok !== true || reply.version !== VERSION) {
    const seen = reply && reply.version ? ` (found bridge ${reply.version})` : '';
    throw new Error(`AirSign page bridge is missing or outdated${seen}. Reload this webpage with Ctrl+R.`);
  }
  return reply;
}

async function ensureBridge(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('No webpage is selected.');
  if (bridgeFailures.has(tabId)) throw bridgeFailures.get(tabId);
  if (bridgePromises.has(tabId)) return bridgePromises.get(tabId);
  const work = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isWebUrl(tab.url)) throw new Error('Chrome protects this page. Select a regular http:// or https:// webpage.');
    try {
      return await pingBridge(tabId);
    } catch (firstError) {
      // A page loaded before AirSign was installed may not yet have the script.
      // Inject it once. If an older bridge is already attached, reload is required.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return await pingBridge(tabId);
      } catch (secondError) {
        throw new Error(`${explain(secondError)}${firstError ? '' : ''}`);
      }
    }
  })();
  bridgePromises.set(tabId, work);
  try {
    const result = await work;
    bridgeFailures.delete(tabId);
    return result;
  } catch (error) {
    bridgePromises.delete(tabId);
    bridgeFailures.set(tabId, error);
    throw error;
  }
}

async function notifyTargetChanged() {
  if (!Number.isInteger(state.targetTabId)) return;
  try {
    const tab = await chrome.tabs.get(state.targetTabId);
    state.targetTitle = tab.title || 'Webpage';
    state.targetUrl = tab.url || '';
    await persist();
    await chrome.runtime.sendMessage({
      type: 'AIRSIGN_TARGET_CHANGED', sessionId: state.sessionId,
      targetTabId: state.targetTabId, targetTitle: state.targetTitle,
      targetUrl: state.targetUrl, version: VERSION
    }).catch(() => {});
  } catch (_) { /* the tab may have closed during the switch */ }
}

async function setTargetTab(tabId) {
  await hydrate();
  if (!Number.isInteger(tabId) || tabId === state.trackerTabId) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
  if (!isWebUrl(tab.url)) return; // Ignore Chrome/extension pages; they cannot be controlled.
  const previous = state.targetTabId;
  if (previous !== tabId && Number.isInteger(previous)) {
    try { await chrome.tabs.sendMessage(previous, { type: 'AIRSIGN_STOP' }); } catch (_) {}
  }
  state.targetTabId = tabId;
  state.targetTitle = tab.title || 'Webpage';
  state.targetUrl = tab.url || '';
  await persist();
  try { await ensureBridge(tabId); }
  catch (error) {
    console.warn('AirSign could not prepare the newly selected webpage:', explain(error));
  }
  await notifyTargetChanged();
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    await hydrate();
    // Activating the tracker tab should not make it the target. Keep the last
    // regular webpage selected, and retarget when the user switches to another one.
    if (activeInfo.tabId === state.trackerTabId) return;
    await setTargetTab(activeInfo.tabId);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') { bridgePromises.delete(tabId); bridgeFailures.delete(tabId); }
  if (changeInfo.status === 'complete') {
    void (async () => {
      await hydrate();
      if (tabId === state.targetTabId && tab && isWebUrl(tab.url)) {
        try { await ensureBridge(tabId); } catch (error) { console.warn('AirSign page bridge:', explain(error)); }
        await notifyTargetChanged();
      }
    })();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await hydrate();
    bridgePromises.delete(tabId); bridgeFailures.delete(tabId);
    if (tabId === state.targetTabId) {
      state.targetTabId = null; state.targetTitle = ''; state.targetUrl = '';
      await persist();
    }
    if (tabId === state.trackerTabId) {
      state = { sessionId: null, trackerTabId: null, sourceType: null, initialTargetTabId: null, targetTabId: null, targetTitle: '', targetUrl: '' };
      await persist();
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'AIRSIGN_REGISTER_TRACKER') {
    void (async () => {
      await hydrate();
      const fromSidePanel = isSidePanelSender(sender);
      const fromTrackerTab = Boolean(sender.tab && Number.isInteger(sender.tab.id));
      if (!fromSidePanel && !fromTrackerTab) throw new Error('The AirSign controller context could not be identified.');
      const initial = Number(message.targetTabId);
      if (!Number.isInteger(initial)) throw new Error('No initial webpage was supplied.');
      state.sessionId = String(message.sessionId || '');
      state.sourceType = fromSidePanel ? 'sidepanel' : 'tracker';
      state.trackerTabId = fromSidePanel ? null : (fromTrackerTab ? sender.tab.id : null);
      state.initialTargetTabId = initial;
      state.targetTabId = initial;
      const tab = await chrome.tabs.get(initial);
      if (!isWebUrl(tab.url)) throw new Error('Select a regular http:// or https:// webpage first.');
      state.targetTitle = tab.title || 'Webpage'; state.targetUrl = tab.url || '';
      await persist();
      await ensureBridge(initial);
      sendResponse({ ok: true, version: VERSION, targetTabId: state.targetTabId, targetTitle: state.targetTitle, targetUrl: state.targetUrl });
    })().catch((error) => sendResponse({ ok: false, version: VERSION, error: explain(error) }));
    return true;
  }

  if (message.type === 'AIRSIGN_GESTURE_FRAME') {
    void (async () => {
      await hydrate();
      const fromSidePanel = isSidePanelSender(sender);
      const fromTrackerTab = Boolean(sender.tab && Number.isInteger(sender.tab.id) && sender.tab.id === state.trackerTabId);
      const sourceMatches = (state.sourceType === 'sidepanel' && fromSidePanel) || (state.sourceType === 'tracker' && fromTrackerTab);
      if (!sourceMatches || String(message.sessionId || '') !== String(state.sessionId || '')) {
        // Recover state if Chrome suspended/restarted the service worker while side-panel tracking is live.
        if (fromSidePanel && message.sessionId && Number.isInteger(Number(message.initialTargetTabId))) {
          state.sessionId = String(message.sessionId);
          state.sourceType = 'sidepanel';
          state.trackerTabId = null;
          state.initialTargetTabId = Number(message.initialTargetTabId);
          if (!Number.isInteger(state.targetTabId)) state.targetTabId = state.initialTargetTabId;
          await persist();
        } else if (fromTrackerTab && message.sessionId && Number.isInteger(Number(message.initialTargetTabId))) {
          state.sessionId = String(message.sessionId);
          state.sourceType = 'tracker';
          state.trackerTabId = sender.tab.id;
          state.initialTargetTabId = Number(message.initialTargetTabId);
          if (!Number.isInteger(state.targetTabId)) state.targetTabId = state.initialTargetTabId;
          await persist();
        } else {
          sendResponse({ ok: false, error: 'AirSign session is no longer registered. Stop and start tracking again.' });
          return;
        }
      }
      if (!Number.isInteger(state.targetTabId)) state.targetTabId = state.initialTargetTabId;
      const targetId = state.targetTabId;
      if (!Number.isInteger(targetId)) { sendResponse({ ok: false, error: 'No webpage is selected.' }); return; }
      try {
        await ensureBridge(targetId);
        const reply = await chrome.tabs.sendMessage(targetId, { type: 'AIRSIGN_FRAME', ...(message.payload || {}) });
        if (!reply || reply.ok !== true || reply.version !== VERSION) throw new Error('The selected webpage did not acknowledge cursor data. Reload it with Ctrl+R.');
        sendResponse({ ok: true, targetTabId: targetId, version: VERSION });
      } catch (error) {
        sendResponse({ ok: false, targetTabId: targetId, pending: true, error: explain(error) });
      }
    })().catch((error) => sendResponse({ ok: false, error: explain(error) }));
    return true;
  }

  if (message.type === 'AIRSIGN_STOP_CURRENT_TARGET') {
    void (async () => {
      await hydrate();
      if (message.sessionId && state.sessionId && String(message.sessionId) !== String(state.sessionId)) {
        sendResponse({ ok: false }); return;
      }
      if (Number.isInteger(state.targetTabId)) {
        try { await chrome.tabs.sendMessage(state.targetTabId, { type: 'AIRSIGN_STOP' }); } catch (_) {}
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: explain(error) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error('AirSign could not configure the side panel:', error);
  });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error('AirSign side panel setup failed:', error);
});
