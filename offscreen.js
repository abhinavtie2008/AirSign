(() => {
  'use strict';

  const VERSION = '2.3.1';
  const DETECT_INTERVAL_MS = 1000 / 30;
  const PREVIEW_INTERVAL_MS = 120;
  const PREVIEW_WIDTH = 320;
  const PREVIEW_HEIGHT = 180;

  const video = document.getElementById('camera');
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');

  const modulesReady = import('./lib/gestures.mjs').then((module) => module);
  let modules = null;
  let settings = null;
  let engine = null;
  let landmarker = null;
  let stream = null;
  let timer = 0;
  let processing = false;
  let lastDetectAt = 0;
  let lastSentHand = false;
  let lastPreviewAt = 0;
  let previewBusy = false;
  let running = false;
  let paused = false;
  let testHand = null;
  let lastPose = 'none';
  let lastVideoTs = 0;
  let lastErrorAt = 0;

  function explain(error) {
    if (!error) return 'Unknown error';
    if (error.message) return error.message;
    return String(error);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => {});
  }

  function reportStatus(state, message = '') {
    send({ type: 'AIRSIGN_TRACKER_STATUS', source: 'offscreen', state, message, version: VERSION });
  }

  function reportError(error) {
    const now = performance.now();
    if (now - lastErrorAt < 3000) return;
    lastErrorAt = now;
    console.error('AirSign tracker error:', error);
    reportStatus('error', explain(error));
  }

  function drawIdlePreview() {
    ctx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    ctx.fillStyle = '#06080f';
    ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  }

  function drawPreview(landmarks, pose) {
    const w = PREVIEW_WIDTH;
    const h = PREVIEW_HEIGHT;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06080f';
    ctx.fillRect(0, 0, w, h);

    if (video.readyState >= 2 || testHand) {
      const sourceAspect = vw / vh;
      const targetAspect = w / h;
      let sx = 0;
      let sy = 0;
      let sw = vw;
      let sh = vh;
      if (sourceAspect > targetAspect) {
        sw = vh * targetAspect;
        sx = (vw - sw) / 2;
      } else {
        sh = vw / targetAspect;
        sy = (vh - sh) / 2;
      }
      if (video.readyState >= 2) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        ctx.restore();
      }

      const mapX = (value) => {
        const mirrored = 1 - value;
        return ((mirrored * vw - sx) / sw) * w;
      };
      const mapY = (value) => ((value * vh - sy) / sh) * h;

      const colors = {
        click: '#34d399',
        drag: '#fbbf24',
        scroll: '#fbbf24',
        point: '#22d3ee',
        idle: 'rgba(34, 211, 238, .7)',
        none: '#22d3ee'
      };
      const lineColor = colors[pose] || colors.none;
      const alpha = pose === 'idle' ? 0.6 : 0.95;

      if (landmarks && landmarks.length >= 21) {
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = lineColor;
        ctx.lineCap = 'round';
        ctx.shadowColor = lineColor;
        ctx.shadowBlur = 8;
        for (const [a, b] of modules.HAND_CONNECTIONS) {
          ctx.beginPath();
          ctx.moveTo(mapX(landmarks[a].x), mapY(landmarks[a].y));
          ctx.lineTo(mapX(landmarks[b].x), mapY(landmarks[b].y));
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < landmarks.length; i += 1) {
          const point = landmarks[i];
          ctx.beginPath();
          ctx.arc(mapX(point.x), mapY(point.y), i === 8 || i === 4 ? 4.2 : 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.arc(mapX(landmarks[8].x), mapY(landmarks[8].y), 13, 0, Math.PI * 2);
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function pushPreview() {
    if (previewBusy) return;
    previewBusy = true;
    const pose = lastPose;
    canvas.toBlob((blob) => {
      if (!blob) {
        previewBusy = false;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        previewBusy = false;
        send({
          type: 'AIRSIGN_BUBBLE_PREVIEW',
          source: 'offscreen',
          dataUrl: reader.result,
          pose,
          handPresent: lastPose !== 'none',
          at: performance.now()
        });
      };
      reader.onerror = () => {
        previewBusy = false;
      };
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.62);
  }

  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This Chrome context has no camera API.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        throw new Error('Camera access was not granted for the background tracker.');
      }
      if (error && error.name === 'NotFoundError') {
        throw new Error('No camera was found on this device.');
      }
      if (error && error.name === 'NotReadableError') {
        throw new Error('The camera is busy in another app.');
      }
      throw new Error(`Could not open the camera (${explain(error)}).`);
    }

    video.srcObject = stream;
    video.muted = true;
    try {
      await video.play();
    } catch (error) {
      stopStream();
      throw new Error(`The camera started but could not be read (${explain(error)}).`);
    }
  }

  function stopStream() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    try {
      video.pause();
      video.srcObject = null;
    } catch (_) {}
  }

  async function createLandmarker() {
    const module = await import('./vendor/vision_bundle.mjs');
    const { FilesetResolver, HandLandmarker } = module;
    const vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
    const options = {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('vendor/hand_landmarker.task'),
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    };
    try {
      return await HandLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn('AirSign: background GPU delegate unavailable, falling back to CPU.', gpuError);
      options.baseOptions.delegate = 'CPU';
      return await HandLandmarker.createFromOptions(vision, options);
    }
  }

  function closeLandmarker() {
    if (landmarker) {
      try { landmarker.close(); } catch (_) {}
      landmarker = null;
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = 0;
    processing = false;
  }

  function sendFrame(frame) {
    const payload = {
      handPresent: Boolean(frame.handPresent),
      pose: frame.pose,
      x: frame.x,
      y: frame.y,
      palmX: frame.palmX,
      palmY: frame.palmY,
      scrollY: frame.scrollY,
      pinchRatio: frame.pinchRatio,
      assist: settings.assist !== false,
      at: frame.at
    };
    send({ type: 'AIRSIGN_TRACKER_FRAME', source: 'offscreen', payload });
  }

  function tick() {
    if (!running || paused || processing) return;

    const now = performance.now();
    if (now - lastDetectAt < DETECT_INTERVAL_MS) return;
    lastDetectAt = now;
    processing = true;

    try {
      let hand = testHand;
      if (!hand) {
        if (!landmarker || !video.videoWidth || video.readyState < 2) {
          processing = false;
          return;
        }
        const timestamp = Math.max(Math.round(now), lastVideoTs + 1);
        lastVideoTs = timestamp;
        const results = landmarker.detectForVideo(video, timestamp);
        hand = results.landmarks && results.landmarks[0] ? results.landmarks[0] : null;
      }

      const frame = engine.update(hand, now);
      lastPose = frame.handPresent ? frame.pose : 'none';
      drawPreview(hand, lastPose);

      if (frame.handPresent) {
        sendFrame(frame);
        lastSentHand = true;
      } else if (lastSentHand) {
        sendFrame(frame);
        lastSentHand = false;
      }

      if (now - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
        lastPreviewAt = now;
        pushPreview();
      }
    } catch (error) {
      reportError(error);
    } finally {
      processing = false;
    }
  }

  async function start(nextSettings) {
    modules = await modulesReady;
    if (!modules) throw new Error('The gesture engine could not be loaded.');

    settings = nextSettings && typeof nextSettings === 'object' ? nextSettings : {};
    if (!engine) {
      engine = modules.createGestureEngine({
        reach: settings.reach,
        smoothing: settings.smoothing,
        mirror: settings.mirror,
        calibration: settings.calibration || null
      });
    } else {
      engine.configure({
        reach: settings.reach,
        smoothing: settings.smoothing,
        mirror: settings.mirror,
        calibration: settings.calibration || null
      });
    }
    engine.reset();

    if (!stream) await openCamera();
    if (!landmarker) landmarker = await createLandmarker();

    running = true;
    paused = false;
    lastSentHand = false;
    lastDetectAt = 0;
    lastPreviewAt = 0;
    lastPose = 'none';
    drawIdlePreview();
    stopTimer();
    timer = setInterval(tick, 33);
    reportStatus('live');
    return true;
  }

  function stopAll() {
    running = false;
    paused = false;
    stopTimer();
    stopStream();
    closeLandmarker();
    engine = null;
    lastSentHand = false;
    lastPose = 'none';
    testHand = null;
    drawIdlePreview();
  }

  function pause() {
    if (!running) return { ok: true, paused: false };
    paused = true;
    stopTimer();
    stopStream();
    reportStatus('paused');
    return { ok: true, paused: true };
  }

  async function resume() {
    if (!running || !paused) return { ok: true, paused: false };
    await openCamera();
    paused = false;
    lastDetectAt = 0;
    lastPreviewAt = 0;
    lastSentHand = false;
    stopTimer();
    timer = setInterval(tick, 33);
    reportStatus('live');
    return { ok: true, paused: false };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'AIRSIGN_OFFSCREEN_PING') {
      sendResponse({ ok: true, version: VERSION, running, paused, pose: lastPose });
      return;
    }

    if (message.type === 'AIRSIGN_OFFSCREEN_START') {
      start(message.settings)
        .then(() => sendResponse({ ok: true, version: VERSION }))
        .catch((error) => {
          console.error('AirSign background tracker could not start:', error);
          reportStatus('error', explain(error));
          sendResponse({ ok: false, error: explain(error) });
        });
      return true;
    }

    if (message.type === 'AIRSIGN_OFFSCREEN_STOP') {
      stopAll();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'AIRSIGN_OFFSCREEN_PAUSE') {
      sendResponse(pause());
      return;
    }

    if (message.type === 'AIRSIGN_OFFSCREEN_RESUME') {
      resume()
        .then((result) => sendResponse(result))
        .catch((error) => {
          reportStatus('error', explain(error));
          sendResponse({ ok: false, error: explain(error) });
        });
      return true;
    }

    if (message.type === 'AIRSIGN_TEST_HAND') {
      testHand = Array.isArray(message.landmarks) ? message.landmarks : null;
      sendResponse({ ok: true });
    }
  });

  window.__airsignOffscreen = {
    version: VERSION,
    get state() {
      return {
        running,
        paused,
        pose: lastPose,
        hasTestHand: Boolean(testHand),
        previewAt: lastPreviewAt
      };
    },
    setHand(landmarks) {
      testHand = Array.isArray(landmarks) ? landmarks : null;
    }
  };
})();
