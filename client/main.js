// main.js
// Glue file: starts the canvases + WebSocket, wires the toolbar and the
// room input, and routes incoming messages (drawing -> canvas.js,
// welcome/users -> sidebar UI).

// ---------- Start up ----------

const canvasElement = document.getElementById('canvas');
const cursorLayerElement = document.getElementById('cursor-canvas');
initCanvas(canvasElement, cursorLayerElement);

connectWebSocket();
setMessageHandler(handleMessage);

// ---------- Toolbar ----------

const colorPicker = document.getElementById('color-picker');
const widthSlider = document.getElementById('width-slider');
const clearButton = document.getElementById('clear-button');
const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');
const brushButton = document.getElementById('brush-button');

colorPicker.addEventListener('input', function () {
  currentColor = colorPicker.value; // lives in canvas.js
});

widthSlider.addEventListener('input', function () {
  currentWidth = Number(widthSlider.value);
});

// Undo/redo/clear are GLOBAL: the server applies them to the room.
clearButton.addEventListener('click', function () {
  sendMessage({ type: 'clear' });
});

undoButton.addEventListener('click', function () {
  sendMessage({ type: 'undo' });
});

redoButton.addEventListener('click', function () {
  sendMessage({ type: 'redo' });
});

// The brush is the only tool in this app. The button exists so a real
// tool system (eraser as a separate tool, shapes, ...) can be added
// without changing the toolbar layout.
brushButton.addEventListener('click', function () {
  brushButton.classList.add('active');
});

// ---------- Room input ----------

const roomInput = document.getElementById('room-input');
const joinRoomButton = document.getElementById('join-room-button');
const currentRoomDisplay = document.getElementById('current-room');

// Same rules as the server, so bad names never leave this tab.
const ROOM_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_ROOM_LENGTH = 32;

function sanitizeRoom(roomId) {
  const trimmed = (roomId || '').trim();
  if (trimmed.length < 1 || trimmed.length > MAX_ROOM_LENGTH) return null;
  if (!ROOM_PATTERN.test(trimmed)) return null;
  return trimmed;
}

joinRoomButton.addEventListener('click', function () {
  const roomId = sanitizeRoom(roomInput.value);
  if (!roomId) {
    roomInput.value = '';
    roomInput.placeholder = '1-32 chars: letters, numbers, - _';
    return;
  }
  switchRoom(roomId);
});

// Forget the old room's visuals, then ask the server for the new room.
function switchRoom(roomId) {
  resetRoomDrawing();               // canvas.js: clear old room visuals
  joinRoom(roomId);                 // websocket.js: remember + send join-room
  currentRoomDisplay.textContent = 'Room: ' + roomId;
  roomInput.value = roomId;
}

// ---------- Identity, room and online users ----------

// The server assigns us an id and a color via the "welcome" message.
let myUser = null;

// Users online in the current room: user id -> { id, color }.
let usersById = {};

// Route every incoming message from the server.
function handleMessage(message) {
  if (message.type === 'welcome') {
    myUser = message.user;
    renderCurrentUser();
    if (message.roomId) {
      currentRoomDisplay.textContent = 'Room: ' + message.roomId;
    }
  } else if (message.type === 'users') {
    updateOnlineUsers(message.users);
  } else if (message.type === 'canvas-state') {
    // Ignore state from a room we already left.
    if (message.roomId && message.roomId !== getCurrentRoomId()) return;
    // Clear also wipes in-progress strokes on the server, so drop them here.
    if (message.cleared) cancelActiveStrokes();
    applyCanvasState(message.operations);
    updateHistoryButtons(message.canUndo, message.canRedo);
  } else if (message.type === 'cursor-move') {
    const user = usersById[message.userId];
    if (user) {
      updateRemoteCursor(user.id, message.x, message.y, user.color);
    }
  } else {
    // stroke-start / stroke-points / stroke-end
    handleRemoteMessage(message);
  }
}

// The server says what Undo/Redo may do - just mirror it on the buttons.
function updateHistoryButtons(canUndo, canRedo) {
  undoButton.disabled = !canUndo;
  redoButton.disabled = !canRedo;
}

// Show "Your ID: ..." with the assigned color in the sidebar.
function renderCurrentUser() {
  document.getElementById('my-color-dot').style.backgroundColor = myUser.color;
  document.getElementById('my-id').textContent = 'Your ID: ' + myUser.id;
}

// Refresh the sidebar's online users list for the current room.
function updateOnlineUsers(users) {
  usersById = {};
  users.forEach(function (user) {
    usersById[user.id] = user;
  });

  // Users no longer in the list went offline - remove their cursors.
  pruneRemoteCursors(new Set(Object.keys(usersById)));

  document.getElementById('online-header').textContent =
    'Online Users (' + users.length + ')';

  const list = document.getElementById('online-users-list');
  list.innerHTML = '';

  users.forEach(function (user) {
    const item = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'user-dot';
    dot.style.backgroundColor = user.color;

    const label = document.createElement('span');
    const isYou = myUser && user.id === myUser.id;
    label.textContent = user.id + (isYou ? ' (You)' : '');

    item.appendChild(dot);
    item.appendChild(label);
    list.appendChild(item);
  });
}

// ---------- Development metrics ----------

// The overlay shows window.__canvasStats (counted in canvas.js).
// Hidden until the user presses "i" outside of a text input.
const debugStatsElement = document.getElementById('debug-stats');

let lastStatsSnapshot = { batches: 0, time: Date.now() }; // for batches/s

function renderDebugStats() {
  const s = window.__canvasStats;
  const now = Date.now();
  const seconds = (now - lastStatsSnapshot.time) / 1000;
  const batchesPerSecond =
    seconds > 0 ? Math.round((s.batchesSent - lastStatsSnapshot.batches) / seconds) : 0;
  lastStatsSnapshot = { batches: s.batchesSent, time: now };

  debugStatsElement.textContent =
    'dev stats (press i to hide)\n' +
    'sent: ' + s.pointsSent + ' pts / ' + s.batchesSent + ' batches\n' +
    'received: ' + s.remotePoints + ' pts / ' + s.remoteBatches + ' batches\n' +
    'rate: ~' + batchesPerSecond + ' batches/s (sent)\n' +
    'strokes: ' + s.strokesCompleted +
    ' | full redraws: ' + s.fullRedraws +
    ' (last: ' + s.lastFullRedrawMs.toFixed(1) + ' ms)';
}

// "i" toggles the overlay (ignored while typing in a field).
document.addEventListener('keydown', function (event) {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (event.key === 'i' || event.key === 'I') {
    debugStatsElement.classList.toggle('visible');
    if (debugStatsElement.classList.contains('visible')) renderDebugStats();
  }
});

// Refresh the overlay once per second while it is visible.
setInterval(function () {
  if (debugStatsElement.classList.contains('visible')) renderDebugStats();
}, 1000);