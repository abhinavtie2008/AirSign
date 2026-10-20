'use strict';
const grant = document.getElementById('grant');
const state = document.getElementById('state');
const settings = document.getElementById('settings');
let requesting = false;
function showError(error) {
  const name = error && error.name ? error.name : 'Error';
  const message = error && error.message ? error.message : String(error || 'Unknown camera error');
  state.textContent = `${name}: ${message}. If access was previously blocked, allow the camera for AirSign in Chrome settings and try again.`;
  state.className = 'error'; settings.hidden = false;
  grant.disabled = false; grant.textContent = 'Try again'; requesting = false;
}
grant.addEventListener('click', async () => {
  if (requesting) return;
  requesting = true; grant.disabled = true; grant.textContent = 'Requesting permission…';
  state.className = ''; state.textContent = 'Waiting for Chrome camera permission…';
  let stream;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera API is unavailable in this page. Update Chrome and try again.');
    stream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'},audio:false});
    stream.getTracks().forEach(track => track.stop());
    await chrome.storage.local.set({airsignCameraGrantConfirmed:true,airsignCameraGrantConfirmedAt:Date.now()});
    state.textContent = 'Camera permission granted. Returning to AirSign…';
    await chrome.runtime.sendMessage({type:'AIRSIGN_CAMERA_PERMISSION_GRANTED'}).catch(()=>{});
    setTimeout(() => window.close(), 700);
  } catch (error) { if (stream) stream.getTracks().forEach(track=>track.stop()); showError(error); }
});
