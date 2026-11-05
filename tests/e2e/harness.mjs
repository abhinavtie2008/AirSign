import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function executableOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function findBrowser() {
  const explicit = process.env.AIRSIGN_CHROME || process.env.CHROME_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`AIRSIGN_CHROME points to a missing file: ${explicit}`);
    return explicit;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge'
    );
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  const fromPath = executableOnPath(
    process.platform === 'win32'
      ? ['chrome', 'msedge']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  );
  if (fromPath) return fromPath;

  throw new Error('No Chrome, Chromium, or Edge executable found. Set AIRSIGN_CHROME to a Chrome 125+ binary.');
}

export async function launchBrowser({ executable, port, profileDir, width = 1280, height = 900 }) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    `--window-size=${width},${height}`,
    'about:blank'
  ];
  if (process.platform === 'linux') args.unshift('--disable-dev-shm-usage');
  // Ephemeral CI runners and root containers usually cannot use Chrome's sandbox.
  if (process.env.CI || (typeof process.getuid === 'function' && process.getuid() === 0)) args.unshift('--no-sandbox');

  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  child.stdout.on('data', () => {});

  return { child, readStderr: () => stderr };
}

export async function waitForEndpoint(port, { child, readStderr, timeout = 30000 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    if (child && child.exitCode !== null) {
      throw new Error(`The browser exited with code ${child.exitCode} before DevTools opened.\n${readStderr ? readStderr() : ''}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`The browser did not expose a DevTools endpoint on port ${port}: ${lastError ? lastError.message : 'timeout'}\n${readStderr ? readStderr() : ''}`);
}

export async function getJson(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${route}`);
  return response.json();
}

export async function waitFor(fn, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  let lastValue;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      lastValue = value;
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const detail = lastError ? ` (${lastError.message})` : ` (last value: ${JSON.stringify(lastValue)})`;
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

export async function waitForTarget(port, predicate, label, timeout = 20000) {
  return waitFor(async () => {
    const targets = await getJson(port, '/json/list');
    return targets.find((target) => target.webSocketDebuggerUrl && predicate(target)) || null;
  }, { timeout, label });
}

export class Cdp {
  constructor(ws, label = 'target') {
    this.ws = ws;
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.logErrors = [];

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.exceptions.push(details.exception?.description || details.text || 'unknown exception');
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.logErrors.push(message.params.entry.text || '');
      } else if (message.method && this.events.has(message.method)) {
        for (const handler of this.events.get(message.method)) handler(message.params);
      }
    };
  }

  on(method, handler) {
    const handlers = this.events.get(method) || [];
    handlers.push(handler);
    this.events.set(method, handlers);
  }

  static async connect(url, label = 'target') {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not connect to ${label}`));
    });
    return new Cdp(ws, label);
  }

  send(method, params = {}, timeout = 30000) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${this.label})`));
      }, timeout);
    });
  }

  async enable() {
    for (const method of ['Runtime.enable', 'Page.enable', 'Log.enable']) {
      await this.send(method).catch(() => {});
    }
  }

  async eval(expression, { contextId = null, awaitPromise = true, userGesture = false } = {}) {
    const params = { expression, awaitPromise, returnByValue: true, userGesture };
    if (contextId !== null) params.contextId = contextId;
    const result = await this.send('Runtime.evaluate', params);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

export async function attachTarget(target, label = target.url || target.type || 'target') {
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl, label);
  await cdp.enable();
  return cdp;
}

export async function openTab(browser, port, url, label = url) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const target = await waitForTarget(port, (candidate) => candidate.id === targetId, `target ${label}`);
  const cdp = await attachTarget(target, label);
  return { targetId, cdp };
}

export async function activateTab(browser, targetId) {
  await browser.send('Target.activateTarget', { targetId });
}

export async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

export async function dragBy(cdp, x, y, dx, dy) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x + (dx * step) / 8),
      y: Math.round(y + (dy * step) / 8),
      button: 'left',
      buttons: 1
    });
    await sleep(30);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(x + dx),
    y: Math.round(y + dy),
    button: 'left',
    buttons: 0,
    clickCount: 1
  });
  await sleep(300);
}

export function killBrowser(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}
