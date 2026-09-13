// server.js
// HTTP (Express, serves client/) + WebSocket (ws) on the same port.
// The server owns the shared canvas: rooms, user ids/colors, drawing
// history, undo/redo/clear. Bad input is validated and never crashes it.

const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const roomsModule = require('./rooms');

const PORT = process.env.PORT || 3000;

// ---------- 1. HTTP server (Express) ----------

const app = express();

// Serve the client/ folder.
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = app.listen(PORT, () => {
  console.log('Server is running at http://localhost:' + PORT);
});

// ---------- 2. WebSocket server ("ws" package) ----------

// Reject any single message bigger than this.
const webSocketServer = new WebSocketServer({ server, maxPayload: 128 * 1024 });

// ---------- Constants ----------

const USER_COLORS = ['#ff4d6d', '#4dabf7', '#51cf66', '#fcc419', '#845ef7', '#ff922b'];

const DEFAULT_ROOM = 'default-room';

// Message types we understand - anything else is ignored.
const KNOWN_TYPES = [
  'join-room',
  'stroke-start', 'stroke-points', 'stroke-end',
  'cursor-move', 'undo', 'redo', 'clear'
];

// ---------- Validation limits ----------

const MAX_ROOM_LENGTH = 32;
const ROOM_PATTERN = /^[a-zA-Z0-9_-]+$/;   // letters, numbers, - and _
const MAX_STROKE_ID_LENGTH = 60;
const MAX_POINTS_PER_MESSAGE = 200;
const MIN_WIDTH = 0.1;
const MAX_WIDTH = 100;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// ---------- Helpers ----------

// Unique id like "user-x7k2m9".
function makeUserId() {
  return 'user-' + Math.random().toString(36).slice(2, 8);
}

// Pick a color nobody in the room uses; reuse the palette when exhausted.
function pickColor(room) {
  const usedColors = new Set(Object.values(room.users).map((user) => user.color));
  for (const color of USER_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  return USER_COLORS[Object.keys(room.users).length % USER_COLORS.length];
}

function isValidRoomId(roomId) {
  return (
    typeof roomId === 'string' &&
    roomId.length >= 1 && roomId.length <= MAX_ROOM_LENGTH &&
    ROOM_PATTERN.test(roomId)
  );
}

function isValidStrokeId(strokeId) {
  return (
    typeof strokeId === 'string' &&
    strokeId.length > 0 && strokeId.length <= MAX_STROKE_ID_LENGTH
  );
}

function isValidPoint(point) {
  return (
    point && typeof point === 'object' &&
    typeof point.x === 'number' && typeof point.y === 'number' &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  );
}

function isValidPointsArray(points) {
  return (
    Array.isArray(points) &&
    points.length > 0 &&
    points.length <= MAX_POINTS_PER_MESSAGE &&
    points.every(isValidPoint)
  );
}

function isValidStrokeStart(message) {
  const stroke = message.stroke;
  return (
    stroke && typeof stroke === 'object' &&
    isValidStrokeId(stroke.id) &&
    typeof stroke.color === 'string' && COLOR_PATTERN.test(stroke.color) &&
    typeof stroke.width === 'number' && Number.isFinite(stroke.width) &&
    stroke.width >= MIN_WIDTH && stroke.width <= MAX_WIDTH &&
    isValidPointsArray(stroke.points)
  );
}

// ---------- Room-scoped broadcasting ----------

// Send a message to every client in this room except one.
function broadcastToRoom(room, message, exceptClient) {
  const raw = JSON.stringify(message);
  room.clients.forEach((client) => {
    if (client !== exceptClient && client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  });
}

// Tell every client in this room who is currently online in it.
function broadcastUsers(room) {
  broadcastToRoom(
    room,
    { type: 'users', roomId: room.id, users: Object.values(room.users) },
    null
  );
}

// Build the authoritative drawing message for a room.
function makeCanvasStateMessage(room) {
  const history = room.state.getHistory();
  return {
    type: 'canvas-state',
    roomId: room.id,
    operations: history,
    canUndo: history.length > 0,
    canRedo: room.state.getRedoLength() > 0
  };
}

// Send the room's drawing to every client in it (including the one that
// caused the change, so undo/redo/clear stay in sync).
function broadcastCanvasState(room) {
  broadcastToRoom(room, makeCanvasStateMessage(room), null);
}

// ---------- Joining a room ----------

// Move a client into a room. Runs on first connect and on "join-room".
function joinRoom(clientSocket, roomId) {
  const userId = clientSocket.userId;

  // Leave the old room. The room itself stays in memory (with its
  // drawing) until the server restarts, so coming back finds it unchanged.
  if (clientSocket.roomId) {
    const oldRoom = roomsModule.getRoom(clientSocket.roomId);
    oldRoom.clients.delete(clientSocket);
    delete oldRoom.users[userId];
    const removedStrokes = oldRoom.state.removeActiveStrokesByUser(userId);
    broadcastUsers(oldRoom);
    // Redraw the others so a leaver's partial stroke pixels disappear.
    if (removedStrokes > 0) {
      broadcastCanvasState(oldRoom);
    }
  }

  // Join (or create) the new room.
  const room = roomsModule.getRoom(roomId);
  clientSocket.roomId = roomId;
  room.clients.add(clientSocket);
  room.users[userId] = { id: userId, color: pickColor(room) };

  clientSocket.send(JSON.stringify({
    type: 'welcome',
    roomId: room.id,
    user: room.users[userId]
  }));

  broadcastUsers(room);

  // Late-join sync: the new user gets the room's current drawing.
  clientSocket.send(JSON.stringify(makeCanvasStateMessage(room)));
}

// ---------- Connections ----------

webSocketServer.on('connection', (clientSocket) => {
  // Identity is decided here - never trust a client-sent user id.
  clientSocket.userId = makeUserId();
  clientSocket.roomId = null;

  console.log('A client connected: ' + clientSocket.userId);

  // Socket errors (e.g. a browser vanishing) must not crash the server.
  clientSocket.on('error', () => {});

  // Every connection starts in the default room.
  joinRoom(clientSocket, DEFAULT_ROOM);

  clientSocket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.log('Ignored a message that is not valid JSON');
      return;
    }

    // Must be a plain object (JSON.parse("null") returns null).
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      console.log('Ignored a message that is not a JSON object');
      return;
    }

    if (!KNOWN_TYPES.includes(message.type)) {
      console.log('Ignored an unknown message type:', message.type);
      return;
    }

    if (message.type === 'join-room') {
      if (!isValidRoomId(message.roomId)) {
        console.log('Ignored an invalid room id');
        return;
      }
      console.log(clientSocket.userId + ' joined room ' + message.roomId);
      joinRoom(clientSocket, message.roomId);
      return;
    }

    // Every other message requires the client to already be in a room.
    const roomId = clientSocket.roomId;
    if (!roomId) {
      console.log('Ignored a message from a client that is not in a room');
      return;
    }
    const room = roomsModule.getRoom(roomId);
    const userId = clientSocket.userId;

    // Cursor positions must be numbers between 0 and 1.
    if (message.type === 'cursor-move') {
      if (!isValidPoint({ x: message.x, y: message.y })) {
        console.log('Ignored a cursor-move with invalid coordinates');
        return;
      }
      broadcastToRoom(
        room,
        { type: 'cursor-move', userId: userId, roomId: room.id, x: message.x, y: message.y },
        clientSocket
      );
      return;
    }

    // A new stroke started. Keep it in the room's active state until stroke-end.
    if (message.type === 'stroke-start') {
      if (!isValidStrokeStart(message)) {
        console.log('Ignored an invalid stroke-start');
        return;
      }
      // A duplicate stroke-start (id already active) is rejected.
      if (!room.state.startStroke(message.stroke, userId)) {
        console.log('Ignored a duplicate stroke-start for ' + message.stroke.id);
        return;
      }
      broadcastToRoom(
        room,
        { type: 'stroke-start', userId: userId, roomId: room.id, stroke: message.stroke },
        clientSocket
      );
      return;
    }

    // More points for an in-progress stroke.
    if (message.type === 'stroke-points') {
      if (!isValidStrokeId(message.strokeId) || !isValidPointsArray(message.points)) {
        console.log('Ignored an invalid stroke-points');
        return;
      }
      if (!room.state.addStrokePoints(message.strokeId, message.points)) {
        console.log('Ignored stroke-points for an unknown stroke');
        return;
      }
      broadcastToRoom(
        room,
        { type: 'stroke-points', userId: userId, roomId: room.id, strokeId: message.strokeId, points: message.points },
        clientSocket
      );
      return;
    }

    // The stroke is finished: turn it into ONE history operation.
    if (message.type === 'stroke-end') {
      if (!isValidStrokeId(message.strokeId)) {
        console.log('Ignored an invalid stroke-end');
        return;
      }
      if (!room.state.endStroke(message.strokeId)) {
        console.log('Ignored stroke-end for an unknown stroke');
        return;
      }
      broadcastToRoom(
        room,
        { type: 'stroke-end', userId: userId, roomId: room.id, strokeId: message.strokeId },
        clientSocket
      );
      broadcastCanvasState(room);
      return;
    }

    // GLOBAL undo: remove the latest operation from THIS room's history.
    if (message.type === 'undo') {
      if (room.state.undo()) {
        console.log('Undo by ' + userId + ' in ' + room.id);
      }
      broadcastCanvasState(room);
      return;
    }

    // GLOBAL redo: put the latest undone operation back into THIS room.
    if (message.type === 'redo') {
      if (room.state.redo()) {
        console.log('Redo by ' + userId + ' in ' + room.id);
      }
      broadcastCanvasState(room);
      return;
    }

    // GLOBAL clear: wipe THIS room's shared state.
    if (message.type === 'clear') {
      room.state.clearAll();
      console.log('Canvas cleared by ' + userId + ' in ' + room.id);
      // cleared flag: clients must also drop in-progress strokes.
      const stateMessage = makeCanvasStateMessage(room);
      stateMessage.cleared = true;
      broadcastToRoom(room, stateMessage, null);
    }
  });

  // Runs when the browser closes the connection.
  clientSocket.on('close', () => {
    // Leave the room, drop half-finished strokes, update the user list.
    if (clientSocket.roomId) {
      const room = roomsModule.getRoom(clientSocket.roomId);
      room.clients.delete(clientSocket);
      delete room.users[clientSocket.userId];
      const removedStrokes = room.state.removeActiveStrokesByUser(clientSocket.userId);
      broadcastUsers(room);
      // The room (and its drawing) stays in memory even when empty.
      // Redraw the others so a leaver's partial stroke pixels disappear.
      if (removedStrokes > 0) {
        broadcastCanvasState(room);
      }
    }
    console.log('A client disconnected: ' + clientSocket.userId);
  });
});