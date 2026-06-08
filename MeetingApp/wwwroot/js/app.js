/**
 * MeetingRoom — app.js
 * WebRTC (native API) + SignalR signaling, chat, file upload, remote control.
 */

// ── Config ────────────────────────────────────────────────────────────────────
// ICE sunucuları /api/config'ten yüklenir — init() içinde doldurulur
let ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data.iceServers?.length) ICE_SERVERS = data.iceServers;
    }
  } catch { /* STUN fallback ile devam */ }
}

// ── State ─────────────────────────────────────────────────────────────────────
const params   = new URLSearchParams(location.search);
const ROOM     = (params.get('room') || '').toUpperCase();
let   MY_NAME  = sessionStorage.getItem('userName') || '';

if (!ROOM) { location.href = '/'; }

let myId            = null;        // assigned by SignalR connection ID
let localStream     = null;        // camera + mic
let screenStream    = null;        // screen share
let isMuted         = false;
let isCameraOff     = false;
let isSharingScreen = false;

// peerId → RTCPeerConnection
const peerConnections = new Map();
// peerId → { video: RTCRtpSender, audio: RTCRtpSender }
const peerSenders     = new Map();
// peerId → { name, audioOn, videoOn, screenOn }
const participants    = new Map();
// peerId → { ctx, animFrame }
const audioMonitors   = new Map();

let unreadCount  = 0;
let chatOpen     = false;
let remoteControlTarget = null;  // connectionId of who we are controlling
let remoteControlActive = false; // we are being controlled by someone

let controlRequesterId   = null; // pending request from this id
let controlRequesterName = '';

// YouTube player state
let ytPlayer  = null;
let ytReady   = false;
let ytPaused  = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const videoGrid          = document.getElementById('videoGrid');
const videoArea          = document.getElementById('videoArea');
const screenShareView    = document.getElementById('screenShareView');
const screenShareVideo   = document.getElementById('screenShareVideo');
const screenShareLabel   = document.getElementById('screenShareLabel');
const remoteControlOverlay  = document.getElementById('remoteControlOverlay');
const requestControlBtn  = document.getElementById('requestControlBtn');
const focusModeBtn       = document.getElementById('focusModeBtn');
const controlRequestModal = document.getElementById('controlRequestModal');
const controlRequestText  = document.getElementById('controlRequestText');
const acceptControlBtn   = document.getElementById('acceptControlBtn');
const denyControlBtn     = document.getElementById('denyControlBtn');
const sidebar            = document.getElementById('sidebar');
const panelParticipants  = document.getElementById('panelParticipants');
const panelChat          = document.getElementById('panelChat');
const chatMessages       = document.getElementById('chatMessages');
const chatInput          = document.getElementById('chatInput');
const unreadBadge        = document.getElementById('unreadBadge');
const participantCount   = document.getElementById('participantCount');
const statusDot          = document.getElementById('statusDot');
const statusText         = document.getElementById('statusText');
const muteBtn            = document.getElementById('muteBtn');
const cameraBtn          = document.getElementById('cameraBtn');
const screenBtn          = document.getElementById('screenBtn');
// Mobile mirror buttons
const muteBtnMobile      = document.getElementById('muteBtnMobile');
const cameraBtnMobile    = document.getElementById('cameraBtnMobile');
const screenBtnMobile    = document.getElementById('screenBtnMobile');

// ── Utilities ─────────────────────────────────────────────────────────────────
function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function avatarColor(id) {
  const colors = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777'];
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    if (u.hostname.endsWith('youtube.com')) return u.searchParams.get('v') || null;
    return null;
  } catch { return null; }
}

function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function setStatus(connected) {
  statusDot.className = `w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400'}`;
  statusText.textContent = connected ? 'Connected' : 'Connecting…';
}

// ── Video tiles ───────────────────────────────────────────────────────────────
function createTile(id, name, stream, isLocal) {
  const existing = document.getElementById(`tile-${id}`);
  if (existing) return existing;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  if (stream) video.srcObject = stream;

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.id = `avatar-${id}`;
  avatar.style.backgroundColor = avatarColor(id);
  avatar.textContent = initials(name);
  avatar.style.display = 'none';

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.id = `label-${id}`;
  label.innerHTML = `${isLocal ? '(You) ' : ''}${name}`;

  const icons = document.createElement('div');
  icons.className = 'tile-icons';
  icons.id = `icons-${id}`;

  // Mic level indicator (top-left)
  const micInd = document.createElement('div');
  micInd.className = 'tile-mic-indicator';
  micInd.id = `mic-ind-${id}`;

  const micFill = document.createElement('div');
  micFill.className = 'mic-fill-bar';
  micFill.id = `mic-fill-${id}`;

  const micSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  micSvg.setAttribute('viewBox', '0 0 24 24');
  micSvg.setAttribute('fill', 'none');
  micSvg.setAttribute('stroke', 'white');
  micSvg.setAttribute('stroke-width', '2.5');
  micSvg.setAttribute('stroke-linecap', 'round');
  micSvg.setAttribute('stroke-linejoin', 'round');
  micSvg.innerHTML = `<path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z"/>`;
  micInd.append(micFill, micSvg);

  tile.append(video, avatar, label, icons, micInd);
  videoGrid.appendChild(tile);
  return tile;
}

function getOrCreateTile(id, name, stream, isLocal) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) tile = createTile(id, name, stream, isLocal);
  return tile;
}

function updateTileStream(id, stream) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  if (video) video.srcObject = stream;
}

function updateTileMediaState(id, audioOn, videoOn) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const video  = tile.querySelector('video');
  const avatar = document.getElementById(`avatar-${id}`);
  const icons  = document.getElementById(`icons-${id}`);

  if (avatar) avatar.style.display = videoOn ? 'none' : 'flex';
  if (video)  video.style.display  = videoOn ? 'block' : 'none';

  // Update icons
  if (icons) {
    icons.innerHTML = '';
    if (!audioOn) icons.innerHTML += `
      <div class="tile-icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/>
        </svg>
      </div>`;
  }
}

function removeTile(id) {
  const el = document.getElementById(`tile-${id}`);
  if (el) el.remove();
}

// ── Participant list ──────────────────────────────────────────────────────────
function renderParticipants() {
  panelParticipants.innerHTML = '';

  // Local
  const localItem = buildParticipantItem(myId || 'local', MY_NAME, !isMuted, !isCameraOff, isSharingScreen, true);
  panelParticipants.appendChild(localItem);

  for (const [id, p] of participants) {
    panelParticipants.appendChild(buildParticipantItem(id, p.name, p.audioOn, p.videoOn, p.screenOn, false));
  }

  participantCount.textContent = participants.size + 1;
}

function buildParticipantItem(id, name, audioOn, videoOn, screenOn, isLocal) {
  const el = document.createElement('div');
  el.className = 'participant-item';

  const av = document.createElement('div');
  av.className = 'p-avatar';
  av.style.backgroundColor = avatarColor(id);
  av.textContent = initials(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'text-sm font-medium truncate flex-1';
  nameEl.textContent = `${name}${isLocal ? ' (You)' : ''}`;

  const icons = document.createElement('div');
  icons.className = 'p-icons';

  const micSvg = audioOn
    ? `<svg class="p-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z"/></svg>`
    : `<svg class="p-icon off" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/></svg>`;

  const camSvg = videoOn
    ? `<svg class="p-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.069A1 1 0 0121 8.869v6.262a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>`
    : `<svg class="p-icon off" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.069A1 1 0 0121 8.869v6.262a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3l18 18"/></svg>`;

  icons.innerHTML = micSvg + camSvg;

  if (screenOn) {
    icons.innerHTML += `<svg class="p-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
  }

  el.append(av, nameEl, icons);
  return el;
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function appendMessage(senderId, senderName, message, timestamp, isFile, fileUrl, fileSize) {
  const isOwn = senderId === myId;
  const div = document.createElement('div');
  div.className = `chat-msg${isOwn ? ' own' : ''}`;

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span class="msg-name">${escapeHtml(senderName)}</span>
    <span class="msg-time">${formatTime(timestamp)}</span>`;

  let body;
  if (isFile) {
    body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = `
      <div class="file-card">
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-gray-100 text-xs truncate">${escapeHtml(message.replace('Shared a file: ', ''))}</div>
          <div class="text-gray-400 text-xs">${formatBytes(fileSize || 0)}</div>
        </div>
        <a href="${escapeHtml(fileUrl || '#')}" download target="_blank"
          class="text-indigo-400 hover:text-indigo-300 text-xs shrink-0 font-medium">Download</a>
      </div>`;
  } else {
    body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = message;
  }

  div.append(header, body);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!chatOpen) {
    unreadCount++;
    unreadBadge.textContent = unreadCount;
    unreadBadge.classList.remove('hidden');
    if (!isOwn) playNotificationSound();
  }
}

function escapeHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

function startAudioMonitor(peerId, stream) {
  stopAudioMonitor(peerId);
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const level = Math.min(avg / 38, 1);
      const fill = document.getElementById(`mic-fill-${peerId}`);
      if (fill) fill.style.height = level > 0.03 ? `${level * 100}%` : '0%';
      audioMonitors.get(peerId).animFrame = requestAnimationFrame(tick);
    }

    audioMonitors.set(peerId, { ctx, animFrame: requestAnimationFrame(tick) });
  } catch (_) {}
}

function stopAudioMonitor(peerId) {
  const m = audioMonitors.get(peerId);
  if (m) {
    cancelAnimationFrame(m.animFrame);
    m.ctx.close().catch(() => {});
    audioMonitors.delete(peerId);
  }
}

// ── YouTube background player ──────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function loadYouTubeAPI() {
  if (window.YT?.Player) { ytReady = true; return; }
  if (document.getElementById('ytApiScript')) return;
  const s = document.createElement('script');
  s.id = 'ytApiScript';
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

function initYTPlayer(videoId, startSeconds = 0) {
  if (!ytReady) { setTimeout(() => initYTPlayer(videoId, startSeconds), 200); return; }
  const vol = parseInt(document.getElementById('ytVolumeSlider')?.value ?? 20);
  const start = Math.max(0, Math.floor(startSeconds));
  if (ytPlayer) {
    ytPlayer.loadVideoById({ videoId, startSeconds: start });
    ytPlayer.setVolume(vol);
    ytPlayer.playVideo();
    return;
  }
  ytPlayer = new YT.Player('ytPlayer', {
    height: '1', width: '1', videoId,
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, start },
    events: {
      onReady: (e) => { e.target.setVolume(vol); e.target.playVideo(); },
      onStateChange: (e) => {
        const playing = e.data === YT.PlayerState.PLAYING;
        ytPaused = !playing;
        document.getElementById('ytPlayIcon')?.classList.toggle('hidden', playing);
        document.getElementById('ytPauseIcon')?.classList.toggle('hidden', !playing);
      }
    }
  });
}

function showYTWidget(title) {
  const widget = document.getElementById('youtubeWidget');
  widget?.classList.remove('hidden');
  const el = document.getElementById('ytWidgetTitle');
  if (el) el.textContent = title || 'Playing...';
  document.getElementById('ytPlayIcon')?.classList.add('hidden');
  document.getElementById('ytPauseIcon')?.classList.remove('hidden');
  ytPaused = false;
}

function hideYTWidget() {
  document.getElementById('youtubeWidget')?.classList.add('hidden');
  if (ytPlayer) { try { ytPlayer.stopVideo(); } catch (_) {} }
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
function createPeerConnection(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(peerId, pc);

  // Add local tracks and store senders by kind
  const senders = {};
  if (localStream) {
    for (const track of localStream.getTracks()) {
      const sender = pc.addTrack(track, localStream);
      senders[track.kind] = sender;
    }
  }
  peerSenders.set(peerId, senders);

  // Send ICE candidates via SignalR
  pc.onicecandidate = e => {
    if (e.candidate)
      connection.invoke('SendIceCandidate', peerId, e.candidate).catch(console.error);
  };

  // Receive remote stream
  pc.ontrack = e => {
    const stream = e.streams[0];
    const p = participants.get(peerId);
    const name = p ? p.name : 'Unknown';

    let tile = document.getElementById(`tile-${peerId}`);
    if (!tile) {
      tile = createTile(peerId, name, stream, false);
    } else {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = stream;
    }

    // Start audio level monitoring for this peer's stream
    if (e.track.kind === 'audio') {
      startAudioMonitor(peerId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      pc.close();
      peerConnections.delete(peerId);
    }
  };

  return pc;
}

async function makeOffer(peerId) {
  const pc = createPeerConnection(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await connection.invoke('SendOffer', peerId, { type: offer.type, sdp: offer.sdp });
  } catch (e) { console.error('makeOffer', e); }
}

async function handleOffer(fromId, offer) {
  const pc = createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await connection.invoke('SendAnswer', fromId, { type: answer.type, sdp: answer.sdp });
  } catch (e) { console.error('handleOffer', e); }
}

async function handleAnswer(fromId, answer) {
  const pc = peerConnections.get(fromId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (e) { console.error('handleAnswer', e); }
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peerConnections.get(fromId);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) { console.error('handleIceCandidate', e); }
}

function closePeer(peerId) {
  stopAudioMonitor(peerId);
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  peerSenders.delete(peerId);
}

async function replaceVideoTrack(newTrack) {
  for (const [, senders] of peerSenders) {
    if (senders.video) await senders.video.replaceTrack(newTrack).catch(console.error);
  }
}

async function replaceAudioTrack(newTrack) {
  for (const [, senders] of peerSenders) {
    if (senders.audio) await senders.audio.replaceTrack(newTrack).catch(console.error);
  }
}

// ── Screen share ──────────────────────────────────────────────────────────────
function showRemoteScreen(stream, sharerName) {
  screenShareView.classList.remove('hidden');
  screenShareVideo.srcObject = stream;
  screenShareLabel.innerHTML = `
    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 4a1 1 0 011-1h14a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>
    </svg>
    ${escapeHtml(sharerName)}'s Screen`;
  requestControlBtn.classList.remove('hidden');
  focusModeBtn.classList.remove('hidden');
  videoArea.classList.add('screen-sharing-active');
}

function hideRemoteScreen() {
  if (document.fullscreenElement === screenShareView) document.exitFullscreen().catch(() => {});
  screenShareView.classList.add('hidden');
  screenShareVideo.srcObject = null;
  requestControlBtn.classList.add('hidden');
  focusModeBtn.classList.add('hidden');
  remoteControlOverlay.classList.add('hidden');
  remoteControlActive = false;
  videoArea.classList.remove('screen-sharing-active');
}

// ── Remote control ────────────────────────────────────────────────────────────
// When we have control — forward mouse/keyboard events via SignalR
function attachRemoteControlListeners(targetId) {
  const el = screenShareVideo;
  const sendEvt = (type, data) =>
    connection.invoke('SendRemoteEvent', targetId, type, data).catch(console.error);

  function onMouseMove(e) {
    const rect = el.getBoundingClientRect();
    sendEvt('mousemove', {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top)  / rect.height
    });
  }
  function onMouseClick(e) {
    const rect = el.getBoundingClientRect();
    sendEvt('click', {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top)  / rect.height,
      button: e.button
    });
  }
  function onKeyDown(e) {
    sendEvt('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
  }

  el.addEventListener('mousemove', onMouseMove);
  el.addEventListener('click', onMouseClick);
  document.addEventListener('keydown', onKeyDown);
  el._rcCleanup = () => {
    el.removeEventListener('mousemove', onMouseMove);
    el.removeEventListener('click', onMouseClick);
    document.removeEventListener('keydown', onKeyDown);
    el._rcCleanup = null;
  };
  el.style.cursor = 'crosshair';
}

function detachRemoteControlListeners() {
  if (screenShareVideo._rcCleanup) screenShareVideo._rcCleanup();
  screenShareVideo.style.cursor = '';
}

// When someone controls us — dispatch synthetic events on document
function dispatchSyntheticEvent(eventType, eventData) {
  if (eventType === 'mousemove' || eventType === 'click') {
    // Synthetic events on the screen share element position (best-effort browser only)
    const rect = screenShareVideo.getBoundingClientRect();
    const x = rect.left + eventData.x * rect.width;
    const y = rect.top  + eventData.y * rect.height;
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const evt = new MouseEvent(eventType, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: eventData.button || 0
    });
    el.dispatchEvent(evt);
  } else if (eventType === 'keydown') {
    const evt = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true,
      key: eventData.key, code: eventData.code,
      ctrlKey: !!eventData.ctrlKey, shiftKey: !!eventData.shiftKey, altKey: !!eventData.altKey
    });
    (document.activeElement || document.body).dispatchEvent(evt);
  }
}

// ── SignalR setup ─────────────────────────────────────────────────────────────
const connection = new signalR.HubConnectionBuilder()
  .withUrl('/meetingHub')
  .withAutomaticReconnect()
  .configureLogging(signalR.LogLevel.Warning)
  .build();

// Event handlers
connection.on('ExistingParticipants', async (list) => {
  for (const p of list) {
    participants.set(p.userId, {
      name: p.userName,
      audioOn: p.isAudioOn,
      videoOn: p.isVideoOn,
      screenOn: p.isSharingScreen
    });
    createTile(p.userId, p.userName, null, false);
    updateTileMediaState(p.userId, p.isAudioOn, p.isVideoOn);
  }
  renderParticipants();

  // Initiate offers to all existing participants
  for (const p of list) await makeOffer(p.userId);
});

connection.on('ChatHistory', (messages) => {
  for (const m of messages)
    appendMessage(m.senderId, m.senderName, m.message, m.timestamp, m.isFile, m.fileUrl, m.fileSize);
});

connection.on('UserJoined', (userId, userName) => {
  participants.set(userId, { name: userName, audioOn: true, videoOn: true, screenOn: false });
  createTile(userId, userName, null, false);
  updateTileMediaState(userId, true, true);
  renderParticipants();
  showToast(`${userName} joined`, 'success');
});

connection.on('UserLeft', (userId, userName) => {
  participants.delete(userId);
  closePeer(userId);
  removeTile(userId);
  renderParticipants();
  showToast(`${userName} left`);

  // If they were sharing screen, hide it
  if (remoteControlTarget === userId) {
    detachRemoteControlListeners();
    remoteControlTarget = null;
  }
  hideRemoteScreen();
});

connection.on('ReceiveMessage', (senderId, senderName, message, timestamp) => {
  appendMessage(senderId, senderName, message, timestamp, false, null, null);
});

connection.on('FileShared', (senderName, fileName, fileUrl, fileSize, timestamp) => {
  appendMessage('file', senderName, `Shared a file: ${fileName}`, timestamp, true, fileUrl, fileSize);
});

connection.on('ReceiveOffer', async (fromId, offer) => {
  await handleOffer(fromId, offer);
});

connection.on('ReceiveAnswer', async (fromId, answer) => {
  await handleAnswer(fromId, answer);
});

connection.on('ReceiveIceCandidate', async (fromId, candidate) => {
  await handleIceCandidate(fromId, candidate);
});

connection.on('ParticipantMediaChanged', (userId, audioOn, videoOn, screenOn) => {
  const p = participants.get(userId);
  if (p) {
    p.audioOn = audioOn;
    p.videoOn = videoOn;
    const wasSharing = p.screenOn;
    p.screenOn = screenOn;

    if (screenOn && !wasSharing) {
      // replaceTrack doesn't fire ontrack again — grab stream from tile.
      // Small delay so the replaced track has time to propagate before we display it.
      const sharerName = p.name;
      setTimeout(() => {
        const vid = document.getElementById(`tile-${userId}`)?.querySelector('video');
        if (vid?.srcObject) showRemoteScreen(vid.srcObject, sharerName);
      }, 300);
    } else if (!screenOn && wasSharing) {
      hideRemoteScreen();
    }
  }
  updateTileMediaState(userId, audioOn, videoOn);
  renderParticipants();
});

// Remote control events
connection.on('RemoteControlRequested', (fromId, fromName) => {
  controlRequesterId   = fromId;
  controlRequesterName = fromName;
  controlRequestText.textContent = `${fromName} is requesting remote control of your screen.`;
  controlRequestModal.classList.remove('hidden');
});

connection.on('RemoteControlAccepted', () => {
  showToast('Remote control accepted', 'success');
  remoteControlOverlay.classList.remove('hidden');
  // Find who is sharing (the target we requested control from)
  const sharer = [...participants.entries()].find(([, p]) => p.screenOn);
  if (sharer) {
    remoteControlTarget = sharer[0];
    attachRemoteControlListeners(remoteControlTarget);
  }
});

connection.on('RemoteControlDenied', () => {
  showToast('Remote control request denied', 'error');
});

connection.on('RemoteControlRevoked', () => {
  detachRemoteControlListeners();
  remoteControlOverlay.classList.add('hidden');
  remoteControlTarget = null;
  showToast('Remote control revoked');
});

connection.on('ReceiveRemoteEvent', (eventType, eventData) => {
  dispatchSyntheticEvent(eventType, eventData);
});

connection.on('ReceiveYouTubePlay', (videoId, senderName, elapsedSeconds) => {
  loadYouTubeAPI();
  showYTWidget(`${senderName} is playing music`);
  initYTPlayer(videoId, elapsedSeconds || 0);
});

connection.on('ReceiveYouTubeStop', () => {
  hideYTWidget();
});

// Reconnect handlers
connection.onreconnecting(() => setStatus(false));
connection.onreconnected(() => setStatus(true));
connection.onclose(() => setStatus(false));

// ── Modal: accept / deny remote control ──────────────────────────────────────
acceptControlBtn.addEventListener('click', () => {
  controlRequestModal.classList.add('hidden');
  remoteControlActive = true;
  const overlayEl = document.createElement('div');
  overlayEl.id = 'sharerControlBanner';
  overlayEl.className = 'fixed top-14 left-1/2 -translate-x-1/2 bg-indigo-700/90 text-white text-xs px-4 py-2 rounded-xl z-40 font-medium';
  overlayEl.textContent = `${controlRequesterName} has remote control — click "Revoke" to stop`;
  const revokeBtn = document.createElement('button');
  revokeBtn.textContent = ' Revoke';
  revokeBtn.className = 'ml-3 underline cursor-pointer';
  revokeBtn.onclick = () => {
    connection.invoke('RevokeRemoteControl', controlRequesterId).catch(console.error);
    overlayEl.remove();
    remoteControlActive = false;
  };
  overlayEl.appendChild(revokeBtn);
  document.body.appendChild(overlayEl);
  if (controlRequesterId)
    connection.invoke('AcceptRemoteControl', controlRequesterId).catch(console.error);
});

denyControlBtn.addEventListener('click', () => {
  controlRequestModal.classList.add('hidden');
  if (controlRequesterId)
    connection.invoke('DenyRemoteControl', controlRequesterId).catch(console.error);
});

// ── Focus mode button ─────────────────────────────────────────────────────────
focusModeBtn.addEventListener('click', () => {
  screenShareView.requestFullscreen().catch(e => {
    showToast('Fullscreen kullanılamıyor: ' + e.message, 'error');
  });
});

// ── Request control button ────────────────────────────────────────────────────
requestControlBtn.addEventListener('click', () => {
  const sharer = [...participants.entries()].find(([, p]) => p.screenOn);
  if (!sharer) return;
  connection.invoke('RequestRemoteControl', sharer[0]).catch(console.error);
  showToast('Control request sent…', 'info');
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────
function syncMuteUI() {
  ['micOnIcon','micOnIconMobile'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', isMuted));
  ['micOffIcon','micOffIconMobile'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', !isMuted));
  [muteBtn, muteBtnMobile].forEach(b => {
    b?.classList.toggle('bg-red-700', isMuted);
    b?.classList.toggle('bg-gray-700', !isMuted);
  });
}

function syncCameraUI() {
  ['camOnIcon','camOnIconMobile'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', isCameraOff));
  ['camOffIcon','camOffIconMobile'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', !isCameraOff));
  [cameraBtn, cameraBtnMobile].forEach(b => {
    b?.classList.toggle('bg-red-700', isCameraOff);
    b?.classList.toggle('bg-gray-700', !isCameraOff);
  });
}

function syncScreenUI() {
  const sharing = isSharingScreen;
  [screenBtn, screenBtnMobile].forEach(b => b?.classList.toggle('bg-indigo-700', sharing));
  screenBtn?.querySelector('span')?.textContent && (screenBtn.querySelector('span').textContent = sharing ? 'Stop Share' : 'Share');
  const mbl = document.getElementById('screenBtnMobileLabel');
  if (mbl) mbl.textContent = sharing ? 'Stop' : 'Share';
}

async function toggleMute() {
  isMuted = !isMuted;
  if (isMuted) {
    for (const t of localStream.getAudioTracks()) { t.stop(); localStream.removeTrack(t); }
    await replaceAudioTrack(null);
    stopAudioMonitor('local');
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = s.getAudioTracks()[0];
      localStream.addTrack(track);
      await replaceAudioTrack(track);
      startAudioMonitor('local', localStream);
    } catch (e) {
      showToast('Mikrofon açılamadı: ' + e.message, 'error');
      isMuted = true;
    }
  }
  syncMuteUI();
  connection.invoke('UpdateMediaState', ROOM, !isMuted, !isCameraOff).catch(console.error);
  renderParticipants();
}

async function toggleCamera() {
  isCameraOff = !isCameraOff;
  if (isCameraOff) {
    for (const t of localStream.getVideoTracks()) { t.stop(); localStream.removeTrack(t); }
    await replaceVideoTrack(null);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = s.getVideoTracks()[0];
      localStream.addTrack(track);
      await replaceVideoTrack(track);
      updateTileStream('local', localStream);
    } catch (e) {
      showToast('Kamera açılamadı: ' + e.message, 'error');
      isCameraOff = true;
    }
  }
  syncCameraUI();
  updateTileMediaState('local', !isMuted, !isCameraOff);
  connection.invoke('UpdateMediaState', ROOM, !isMuted, !isCameraOff).catch(console.error);
  renderParticipants();
}

muteBtn?.addEventListener('click', toggleMute);
muteBtnMobile?.addEventListener('click', toggleMute);
cameraBtn?.addEventListener('click', toggleCamera);
cameraBtnMobile?.addEventListener('click', toggleCamera);

// ── Mirror guard ──────────────────────────────────────────────────────────────
let mirrorVisibilityHandler = null;

function getMirrorWarningEl() {
  let el = document.getElementById('screenMirrorWarning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'screenMirrorWarning';
    el.className = 'screen-mirror-warning';
    el.innerHTML = `
      <div class="mirror-warning-icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        </svg>
      </div>
      <p class="mirror-warning-title">İçiçe ekran görüntüsü uyarısı</p>
      <p class="mirror-warning-body">Şu anda bulunduğunuz sekme paylaşılıyor.<br>
        <strong>Başka bir sekmeye geçtiğinizde</strong> ekran paylaşımı otomatik olarak aktif olacak.</p>`;
    screenShareView.appendChild(el);
  }
  return el;
}

function showMirrorWarning() {
  getMirrorWarningEl().classList.remove('hidden');
}

function hideMirrorWarning() {
  document.getElementById('screenMirrorWarning')?.classList.add('hidden');
}

function setupMirrorGuard() {
  teardownMirrorGuard();
  // Show warning immediately if this tab is visible (= mirror risk)
  if (!document.hidden) showMirrorWarning();

  mirrorVisibilityHandler = () => {
    if (document.hidden) {
      // User switched to another tab/window — safe to share
      hideMirrorWarning();
    } else {
      // User returned to meeting tab — mirror risk again
      showMirrorWarning();
    }
  };
  document.addEventListener('visibilitychange', mirrorVisibilityHandler);
}

function teardownMirrorGuard() {
  if (mirrorVisibilityHandler) {
    document.removeEventListener('visibilitychange', mirrorVisibilityHandler);
    mirrorVisibilityHandler = null;
  }
  hideMirrorWarning();
}

const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

function hideScreenShareButtons() {
  screenBtn?.classList.add('hidden');
  screenBtnMobile?.classList.add('hidden');
}

async function toggleScreen() {
  if (!screenShareSupported) {
    showToast('Ekran paylaşımı bu tarayıcıda desteklenmiyor. Masaüstü Chrome veya Firefox kullanın.', 'error');
    return;
  }
  if (!isSharingScreen) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isSharingScreen = true;
      syncScreenUI();

      screenShareView.classList.remove('hidden');
      screenShareVideo.srcObject = screenStream;
      screenShareLabel.innerHTML = `<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M2 4a1 1 0 011-1h14a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/></svg> Your Screen`;
      requestControlBtn.classList.add('hidden');
      focusModeBtn.classList.remove('hidden');
      videoArea.classList.add('screen-sharing-active');

      const screenTrack = screenStream.getVideoTracks()[0];
      await replaceVideoTrack(screenTrack);
      swapRecordingVideoTrack();
      await connection.invoke('UpdateScreenShareState', ROOM, true);
      screenTrack.onended = () => stopScreenShare();

      setupMirrorGuard();
    } catch (e) {
      if (e.name !== 'NotAllowedError') showToast('Ekran paylaşımı başlatılamadı: ' + e.message, 'error');
    }
  } else {
    await stopScreenShare();
  }
}

if (!screenShareSupported) hideScreenShareButtons();

screenBtn?.addEventListener('click', toggleScreen);
screenBtnMobile?.addEventListener('click', toggleScreen);

async function stopScreenShare() {
  teardownMirrorGuard();
  if (document.fullscreenElement === screenShareView) await document.exitFullscreen().catch(() => {});
  if (screenStream) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
  }
  isSharingScreen = false;
  syncScreenUI();

  const camTrack = localStream?.getVideoTracks()[0] || null;
  await replaceVideoTrack(camTrack);
  swapRecordingVideoTrack();

  screenShareView.classList.add('hidden');
  screenShareVideo.srcObject = null;
  focusModeBtn.classList.add('hidden');
  videoArea.classList.remove('screen-sharing-active');

  await connection.invoke('UpdateScreenShareState', ROOM, false).catch(console.error);
}

// ── Sidebar / tabs ────────────────────────────────────────────────────────────
function openSidebar(tab) {
  sidebar.classList.remove('hidden');
  const isParticipants = tab === 'participants';
  panelParticipants.classList.toggle('hidden', !isParticipants);
  panelChat.classList.toggle('hidden', isParticipants);

  document.getElementById('tabParticipants').className =
    `sidebar-tab flex-1 py-3 text-sm font-medium border-b-2 ${isParticipants ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`;
  document.getElementById('tabChat').className =
    `sidebar-tab flex-1 py-3 text-sm font-medium border-b-2 ${!isParticipants ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`;

  if (!isParticipants) {
    chatOpen = true;
    unreadCount = 0;
    unreadBadge.classList.add('hidden');
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

document.getElementById('participantsBtn').addEventListener('click', () => {
  if (!sidebar.classList.contains('hidden') && !panelParticipants.classList.contains('hidden')) {
    sidebar.classList.add('hidden');
  } else {
    openSidebar('participants');
  }
});

document.getElementById('chatBtn').addEventListener('click', () => {
  if (!sidebar.classList.contains('hidden') && !panelChat.classList.contains('hidden')) {
    sidebar.classList.add('hidden');
    chatOpen = false;
  } else {
    openSidebar('chat');
  }
});

document.getElementById('tabParticipants').addEventListener('click', () => openSidebar('participants'));
document.getElementById('tabChat').addEventListener('click', () => openSidebar('chat'));

// ── Chat send ─────────────────────────────────────────────────────────────────
async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value = '';

  if (msg.startsWith('/play ')) {
    const url = msg.slice(6).trim();
    const videoId = extractYouTubeId(url);
    if (!videoId) { showToast('Geçerli bir YouTube linki girin', 'error'); return; }
    try { await connection.invoke('PlayYouTube', ROOM, videoId); }
    catch (e) { showToast('Müzik başlatılamadı', 'error'); }
    return;
  }

  if (msg === '/stop') {
    try { await connection.invoke('StopYouTube', ROOM); }
    catch (e) { showToast('Müzik durdurulamadı', 'error'); }
    return;
  }

  try {
    await connection.invoke('SendMessage', ROOM, msg);
  } catch (e) { showToast('Failed to send message', 'error'); }
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// ── File upload ───────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 52_428_800) {
    showToast('File exceeds 50 MB limit', 'error');
    return;
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('roomCode', ROOM);

  showToast('Uploading…', 'info');

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const { fileName, fileUrl, fileSize } = await res.json();
    await connection.invoke('NotifyFileShared', ROOM, fileName, fileUrl, fileSize);
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }

  e.target.value = '';
});

// ── Recording ─────────────────────────────────────────────────────────────────
const PART_SIZE_LIMIT = 500 * 1024 * 1024; // 500 MB per part

let isRecording    = false;
let mediaRecorder  = null;
let recordAudioCtx = null;
let recordMimeType = '';
let recordExt      = 'webm';

// Part management
let recordParts  = [];   // { blob: Blob, partNum: number }[]  — sealed parts
let partChunks   = [];   // Uint8Array chunks for the current part
let partSize     = 0;    // bytes accumulated in the current part
let partNum      = 1;    // 1-based current part index

// Canvas + Worker
let recordCanvas    = null;
let recordCanvasCtx = null;
let recordSrcEl     = null;
let recordWorker    = null;

const _DRAW_WORKER = `
  let iv = null;
  onmessage = e => {
    if (e.data === 'start') iv = setInterval(() => postMessage(0), 33);
    else { clearInterval(iv); iv = null; close(); }
  };
`;

function getRecordSourceEl() {
  if (isSharingScreen && screenStream) return screenShareVideo;
  return document.getElementById('tile-local')?.querySelector('video') ?? null;
}

function buildRecordingStream() {
  recordAudioCtx = new AudioContext();
  const dest = recordAudioCtx.createMediaStreamDestination();
  const addAudio = track => {
    try { recordAudioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest); }
    catch (_) {}
  };
  if (localStream) localStream.getAudioTracks().forEach(addAudio);
  for (const [peerId] of peerConnections) {
    const vid = document.getElementById(`tile-${peerId}`)?.querySelector('video');
    if (vid?.srcObject) vid.srcObject.getAudioTracks().forEach(addAudio);
  }

  recordCanvas = document.createElement('canvas');
  recordCanvas.width  = 1280;
  recordCanvas.height = 720;
  recordCanvasCtx = recordCanvas.getContext('2d');
  recordSrcEl = getRecordSourceEl();

  const workerBlob = new Blob([_DRAW_WORKER], { type: 'text/javascript' });
  recordWorker = new Worker(URL.createObjectURL(workerBlob));
  recordWorker.onmessage = () => {
    if (!recordCanvasCtx) return;
    if (recordSrcEl && recordSrcEl.readyState >= 2)
      recordCanvasCtx.drawImage(recordSrcEl, 0, 0, recordCanvas.width, recordCanvas.height);
    else {
      recordCanvasCtx.fillStyle = '#111827';
      recordCanvasCtx.fillRect(0, 0, recordCanvas.width, recordCanvas.height);
    }
  };
  recordWorker.postMessage('start');

  return new MediaStream([
    ...recordCanvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);
}

function swapRecordingVideoTrack() { recordSrcEl = getRecordSourceEl(); }

function cleanupRecordingCanvas() {
  if (recordWorker) { recordWorker.postMessage('stop'); recordWorker = null; }
  recordCanvas = recordCanvasCtx = recordSrcEl = null;
}

// ── Part management ───────────────────────────────────────────────────────────
function sealCurrentPart() {
  if (!partChunks.length) return;
  const blob = new Blob(partChunks, { type: recordMimeType || 'video/webm' });
  recordParts.push({ blob, partNum });
  showToast(`Part ${partNum} tamamlandı — ${formatBytes(blob.size)}`, 'info');
  partNum++;
  partChunks = [];
  partSize   = 0;
  updateRecordProgress();
}

function updateRecordProgress() {
  if (!isRecording) return;
  const totalParts = recordParts.length + 1; // sealed + current
  const sizeStr    = formatBytes(partSize);
  const partLabel  = totalParts > 1 || partSize >= PART_SIZE_LIMIT * 0.1
    ? ` · Part ${partNum}`
    : '';
  const label  = document.getElementById('recordBtnLabel');
  const labelM = document.getElementById('recordBtnMobileLabel');
  if (label)  label.textContent  = `${sizeStr}${partLabel}`;
  if (labelM) labelM.textContent = `${sizeStr}`;
}

// ── Download helpers ──────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function finalizeRecording() {
  sealCurrentPart(); // seal whatever is left
  if (!recordParts.length) return;

  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `meeting_${ROOM}_${ts}`;

  if (recordParts.length === 1) {
    // Single part — direct download, no ZIP needed
    triggerDownload(recordParts[0].blob, `${baseName}.${recordExt}`);
    showToast('Kayıt indirildi', 'success');
  } else {
    // Multiple parts — create ZIP with Part badges
    showToast('ZIP oluşturuluyor…', 'info');
    try {
      const zip = new JSZip();
      for (const { blob, partNum: n } of recordParts)
        zip.file(`${baseName}_Part${n}.${recordExt}`, blob);

      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' }, // STORE = no re-compress, just bundle
        meta => {
          const pct = Math.round(meta.percent);
          const label = document.getElementById('recordBtnLabel');
          if (label) label.textContent = `ZIP %${pct}`;
        }
      );
      triggerDownload(zipBlob, `${baseName}_${recordParts.length}parts.zip`);
      showToast(`${recordParts.length} parça ZIP olarak indirildi`, 'success');
    } catch (err) {
      showToast('ZIP oluşturma hatası: ' + err.message, 'error');
    }
  }

  // Reset state for next recording
  recordParts = [];
  partChunks  = [];
  partSize    = 0;
  partNum     = 1;
}

// ── UI sync ───────────────────────────────────────────────────────────────────
function syncRecordUI() {
  const recording = isRecording;
  ['recordBtn', 'recordBtnMobile'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.classList.toggle('bg-red-700',      recording);
    b.classList.toggle('hover:bg-red-600', recording);
    b.classList.toggle('bg-gray-700',     !recording);
    b.classList.toggle('hover:bg-gray-600', !recording);
  });
  ['recordStartIcon', 'recordStartIconMobile'].forEach(id =>
    document.getElementById(id)?.classList.toggle('hidden', recording));
  ['recordStopIcon', 'recordStopIconMobile'].forEach(id =>
    document.getElementById(id)?.classList.toggle('hidden', !recording));

  if (!recording) {
    const label  = document.getElementById('recordBtnLabel');
    const labelM = document.getElementById('recordBtnMobileLabel');
    if (label)  label.textContent  = 'Record';
    if (labelM) labelM.textContent = 'Rec';
  }
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
async function startRecording() {
  const stream = buildRecordingStream();
  if (!stream.getTracks().length) {
    showToast('No media to record', 'error');
    cleanupRecordingCanvas();
    return;
  }

  // Reset part state
  recordParts = [];
  partChunks  = [];
  partSize    = 0;
  partNum     = 1;

  recordMimeType = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
  recordExt = recordMimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

  mediaRecorder = new MediaRecorder(stream, recordMimeType ? { mimeType: recordMimeType } : {});

  mediaRecorder.ondataavailable = e => {
    if (!e.data.size) return;
    partChunks.push(e.data);
    partSize += e.data.size;
    updateRecordProgress();
    if (partSize >= PART_SIZE_LIMIT) sealCurrentPart();
  };

  mediaRecorder.onstop = () => {
    cleanupRecordingCanvas();
    recordAudioCtx?.close().catch(() => {});
    recordAudioCtx = null;
    finalizeRecording();
  };

  mediaRecorder.start(1000);
  isRecording = true;
  syncRecordUI();
  showToast(`Kayıt başladı (${recordExt.toUpperCase()})`, 'info');
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  isRecording = false;
  syncRecordUI();
  showToast('Kayıt durduruluyor…', 'info');
}

function toggleRecording() {
  if (isRecording) stopRecording(); else startRecording();
}

document.getElementById('recordBtn')?.addEventListener('click', toggleRecording);
document.getElementById('recordBtnMobile')?.addEventListener('click', toggleRecording);

// ── Leave ─────────────────────────────────────────────────────────────────────
async function doLeave() {
  if (isRecording) stopRecording();
  await stopScreenShare().catch(() => {});
  stopAudioMonitor('local');
  await connection.invoke('LeaveRoom', ROOM).catch(() => {});
  await connection.stop().catch(() => {});
  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();
  peerSenders.clear();
  if (localStream) for (const t of localStream.getTracks()) t.stop();
  location.href = '/';
}

document.getElementById('leaveBtn')?.addEventListener('click', doLeave);
document.getElementById('leaveBtnMobile')?.addEventListener('click', doLeave);
document.getElementById('leaveBtnMobile2')?.addEventListener('click', doLeave);

// YouTube widget controls
document.getElementById('ytPlayPauseBtn')?.addEventListener('click', () => {
  if (!ytPlayer) return;
  if (ytPaused) { ytPlayer.playVideo(); } else { ytPlayer.pauseVideo(); }
});

document.getElementById('ytStopBtn')?.addEventListener('click', () => {
  connection.invoke('StopYouTube', ROOM).catch(console.error);
});

document.getElementById('ytVolumeSlider')?.addEventListener('input', (e) => {
  if (ytPlayer) ytPlayer.setVolume(parseInt(e.target.value));
});

// Copy room code
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM).then(() => showToast('Room code copied!', 'success'));
});
document.getElementById('roomCodeDisplay').textContent = ROOM;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadConfig();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    showToast('Could not access camera/mic — joining without media', 'error');
    localStream = new MediaStream();
  }

  createTile('local', MY_NAME, localStream, true);
  updateTileMediaState('local', true, true);
  if (localStream.getAudioTracks().length) startAudioMonitor('local', localStream);

  try {
    await connection.start();
    myId = connection.connectionId;
    setStatus(true);
    await connection.invoke('JoinRoom', ROOM, MY_NAME);
    await connection.invoke('UpdateMediaState', ROOM, !isMuted, !isCameraOff);
    renderParticipants();
  } catch (e) {
    setStatus(false);
    showToast('Could not connect to server: ' + e.message, 'error');
  }
}

// ── Name prompt / boot ────────────────────────────────────────────────────────
const namePrompt     = document.getElementById('namePrompt');
const promptRoomCode = document.getElementById('promptRoomCode');
const promptName     = document.getElementById('promptName');
const promptJoinBtn  = document.getElementById('promptJoinBtn');

function bootWithName(name) {
  MY_NAME = name;
  sessionStorage.setItem('userName', name);
  namePrompt?.classList.add('hidden');
  init();
}

if (MY_NAME) {
  // Name already known — join immediately
  init();
} else {
  // Show name prompt
  if (promptRoomCode) promptRoomCode.textContent = ROOM;
  namePrompt?.classList.remove('hidden');
  setTimeout(() => promptName?.focus(), 100);
}

promptJoinBtn?.addEventListener('click', () => {
  const name = promptName?.value.trim();
  if (!name) { promptName?.focus(); return; }
  bootWithName(name);
});

promptName?.addEventListener('keydown', e => {
  if (e.key === 'Enter') promptJoinBtn?.click();
});
