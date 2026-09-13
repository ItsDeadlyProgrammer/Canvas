// websocket.js
// Handles the WebSocket connection: connect/reconnect with backoff,
// sending JSON messages, and passing incoming messages to main.js.

let socket = null;
let messageHandler = null; // set by main.js via setMessageHandler()

// The room to (re)join on every connect. Changed via joinRoom().
let currentRoomId = 'default-room';

// Reconnection backoff: 1s, 2s, 4s, 8s ... capped at 10s.
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 10000;

function element(id) {
  return document.getElementById(id);
}

// Show the connection state: Connected / Reconnecting... / Disconnected.
function setConnectionStatus(state) {
  const dot = element('status-dot');
  const text = element('status-text');

  dot.classList.remove('connected', 'reconnecting', 'disconnected');

  if (state === 'connected') {
    dot.classList.add('connected');
    text.textContent = 'Connected';
  } else if (state === 'reconnecting') {
    dot.classList.add('reconnecting');
    text.textContent = 'Reconnecting...';
  } else {
    dot.classList.add('disconnected');
    text.textContent = 'Disconnected';
  }
}

function connectWebSocket() {
  if (socket) return; // only one connection at a time

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = protocol + '://' + window.location.host;

  socket = new WebSocket(url);

  socket.onopen = function () {
    reconnectAttempts = 0;
    setConnectionStatus('connected');

    // Re-join our room (also runs after a reconnect).
    sendMessage({ type: 'join-room', roomId: currentRoomId });
  };

  socket.onmessage = function (event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return; // not valid JSON - ignore
    }

    if (messageHandler) messageHandler(message);
  };

  socket.onclose = function () {
    socket = null;

    cancelLocalStroke(); // drop a half-finished stroke, the server does too

    setConnectionStatus('reconnecting');
    scheduleReconnect();
  };

  socket.onerror = function () {
    // onclose fires right after onerror, nothing to do here.
  };
}

// Retry with a 1s, 2s, 4s, 8s, ... backoff capped at 10s.
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts += 1;

  reconnectTimer = setTimeout(connectWebSocket, delay);
}

// Send an object to the server as JSON.
function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function setMessageHandler(handler) {
  messageHandler = handler;
}

// Switch rooms. The id is remembered so a reconnect re-joins it.
function joinRoom(roomId) {
  if (!roomId) return;
  currentRoomId = roomId;

  if (socket && socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: 'join-room', roomId: roomId });
  }
}

function getCurrentRoomId() {
  return currentRoomId;
}