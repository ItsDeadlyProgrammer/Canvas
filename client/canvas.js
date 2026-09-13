// canvas.js
// Drawing (local + remote) on #canvas, remote cursors on #cursor-canvas.
// Local strokes render immediately; the server state arrives via
// "canvas-state" messages and triggers a full redraw.

// ---------- State ----------

let canvas;       // drawing canvas
let ctx;
let cursorCanvas; // transparent layer for remote cursors
let cursorCtx;

let currentColor = '#111111'; // brush settings (set by main.js)
let currentWidth = 3;

let isDrawing = false;
let currentStroke = null;     // stroke in progress, points normalized (0..1)
let pendingPoints = [];       // points waiting to be sent to the server
let activeRemoteStrokes = {}; // remote strokes in progress, by stroke id
let remoteCursors = {};       // remote cursors, by user id
let operations = [];          // our copy of the server's operations
let flushScheduled = false;
let lastCursorSent = 0;       // for cursor throttling

// Points closer than this (CSS px) to the last accepted point are skipped.
const MIN_POINT_DISTANCE = 2;

// Max points per stroke-points message (same limit as server.js).
const MAX_POINTS_PER_MESSAGE = 200;

// Dev metrics, hidden by default (press "i" to show, see main.js).
const stats = {
  pointsSent: 0,      // points we sent to the server
  batchesSent: 0,     // stroke-points messages we sent
  remotePoints: 0,    // points we received for remote strokes
  remoteBatches: 0,   // stroke-points messages we received
  strokesCompleted: 0,// local strokes finished
  fullRedraws: 0,     // full canvas rebuilds (canvas-state / resize)
  lastFullRedrawMs: 0 // how long the last full redraw took
};
window.__canvasStats = stats;

// ---------- Setup ----------

function initCanvas(canvasElement, cursorLayerElement) {
  canvas = canvasElement;
  ctx = canvas.getContext('2d');

  cursorCanvas = cursorLayerElement;
  cursorCtx = cursorCanvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Pointer events cover mouse, touch and pen.
  canvas.addEventListener('pointerdown', startStroke);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
}

// Match the canvas to its on-screen size, then redraw (points are
// normalized, so resizing keeps the drawing).
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1; // high-DPI support

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr); // draw in CSS pixels

  cursorCanvas.width = canvas.width;
  cursorCanvas.height = canvas.height;
  cursorCtx.scale(dpr, dpr);

  redrawCanvas();
  drawRemoteCursors();
}

// Pointer position relative to the canvas.
function getPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

// ---------- Coordinate helpers ----------

// Canvas size in CSS pixels (what the user sees).
function getCanvasSize() {
  const rect = canvas.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// Canvas point -> normalized (0..1), so coordinates are size-independent.
function toNormalized(point) {
  const size = getCanvasSize();
  return {
    x: point.x / size.width,
    y: point.y / size.height
  };
}

// Normalized point -> canvas pixels.
function toCanvasPoint(point) {
  const size = getCanvasSize();
  return {
    x: point.x * size.width,
    y: point.y * size.height
  };
}

// ---------- Redrawing from the shared operations ----------

// Full redraw from the shared operations. Strokes still in progress are
// drawn again on top, so a redraw can't wipe pixels being drawn right now.
function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  operations.forEach(function (operation) {
    if (operation.type === 'stroke') {
      drawStrokeFromPoints(operation.stroke);
    }
  });

  if (currentStroke && currentStroke.points.length > 0) {
    drawStrokeFromPoints(currentStroke);
  }
  Object.keys(activeRemoteStrokes).forEach(function (strokeId) {
    drawStrokeFromPoints(activeRemoteStrokes[strokeId]);
  });
}

// Take the server's operation list and redraw (also timed for dev stats).
function applyCanvasState(newOperations) {
  operations = newOperations;
  const startedAt = performance.now();
  redrawCanvas();
  stats.fullRedraws += 1;
  stats.lastFullRedrawMs = performance.now() - startedAt;
}

// Clear everything from the current room (used when switching rooms).
function resetRoomDrawing() {
  isDrawing = false;
  currentStroke = null;
  pendingPoints = [];
  activeRemoteStrokes = {};
  remoteCursors = {};
  operations = [];
  redrawCanvas();
  drawRemoteCursors();
}

// Drop the local half-finished stroke (used when the socket drops).
function cancelLocalStroke() {
  isDrawing = false;
  currentStroke = null;
  pendingPoints = [];
}

// Drop all in-progress strokes, local + remote (used when the room is
// cleared - the server wipes its active strokes too).
function cancelActiveStrokes() {
  isDrawing = false;
  currentStroke = null;
  pendingPoints = [];
  activeRemoteStrokes = {};
}

// ---------- Drawing helpers ----------

// Draw one short line segment with the given color and width.
function drawSegment(from, to, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round'; // round ends look nicer
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

// Draw a single dot (so a click without a move still leaves a mark).
function drawDot(point, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(point.x + 0.01, point.y + 0.01);
  ctx.stroke();
}

// Draw a whole stroke from its normalized points.
function drawStrokeFromPoints(stroke) {
  if (!stroke || stroke.points.length === 0) return;

  if (stroke.points.length === 1) {
    drawDot(toCanvasPoint(stroke.points[0]), stroke.color, stroke.width);
    return;
  }

  // Connect every pair of neighbouring points.
  for (let i = 1; i < stroke.points.length; i++) {
    drawSegment(
      toCanvasPoint(stroke.points[i - 1]),
      toCanvasPoint(stroke.points[i]),
      stroke.color,
      stroke.width
    );
  }
}

// Create a simple unique id for a stroke (timestamp + random part).
function makeStrokeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Sending to the server ----------

// Send the collected points to the server (batched per frame).
function flushPoints() {
  if (pendingPoints.length === 0) return;
  if (!currentStroke) return;

  // Split into server-sized batches.
  while (pendingPoints.length > 0) {
    const batch = pendingPoints.splice(0, MAX_POINTS_PER_MESSAGE);
    sendMessage({
      type: 'stroke-points',
      strokeId: currentStroke.id,
      points: batch
    });
    stats.batchesSent += 1;
    stats.pointsSent += batch.length;
  }
}

// Flush at most once per animation frame.
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  requestAnimationFrame(function () {
    flushScheduled = false;
    flushPoints();
  });
}

// ---------- Local drawing ----------

function startStroke(event) {
  isDrawing = true;
  const point = getPoint(event);
  const normalized = toNormalized(point);

  currentStroke = {
    id: makeStrokeId(),
    color: currentColor,
    width: currentWidth,
    points: [normalized]
  };

  drawDot(point, currentStroke.color, currentStroke.width);

  sendMessage({
    type: 'stroke-start',
    stroke: {
      id: currentStroke.id,
      color: currentStroke.color,
      width: currentStroke.width,
      points: [normalized]
    }
  });

  // Keep getting pointermove events even outside the canvas.
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (error) {
    // No active pointer - ignore.
  }
}

function handlePointerMove(event) {
  sendLocalCursor(event);
  if (isDrawing) continueStroke(event);
}

// Extend the stroke with the new point.
function continueStroke(event) {
  if (!isDrawing) return;

  const point = getPoint(event);
  const normalized = toNormalized(point);

  const previous = toCanvasPoint(
    currentStroke.points[currentStroke.points.length - 1]
  );

  // Point reduction: skip samples that barely moved.
  const dx = point.x - previous.x;
  const dy = point.y - previous.y;
  if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return;

  currentStroke.points.push(normalized);
  pendingPoints.push(normalized);
  drawSegment(previous, point, currentStroke.color, currentStroke.width);

  scheduleFlush();
}

function endStroke() {
  if (!isDrawing) return;

  flushPoints();

  if (currentStroke) {
    sendMessage({ type: 'stroke-end', strokeId: currentStroke.id });
    stats.strokesCompleted += 1;
  }

  isDrawing = false;
  currentStroke = null;
  pendingPoints = [];
}

// ---------- Cursor position synchronization ----------

// Send our cursor position (throttled to ~25 updates/sec).
function sendLocalCursor(event) {
  const now = Date.now();
  if (now - lastCursorSent < 40) return; // wait 40ms = 25 updates/sec

  lastCursorSent = now;

  const normalized = toNormalized(getPoint(event));
  sendMessage({ type: 'cursor-move', x: normalized.x, y: normalized.y });
}

// ---------- Remote strokes ----------

// Incoming messages from other users (called by main.js).
function handleRemoteMessage(message) {
  if (message.type === 'stroke-start') {
    startRemoteStroke(message.stroke);
  } else if (message.type === 'stroke-points') {
    addRemotePoints(message.strokeId, message.points);
  } else if (message.type === 'stroke-end') {
    endRemoteStroke(message.strokeId);
  }
}

// A remote user began a stroke.
function startRemoteStroke(stroke) {
  // Ignore duplicates - we are already drawing this stroke.
  if (activeRemoteStrokes[stroke.id]) return;

  // Keep the full point list so a full redraw can replay this stroke.
  activeRemoteStrokes[stroke.id] = {
    id: stroke.id,
    color: stroke.color,
    width: stroke.width,
    lastPoint: toCanvasPoint(stroke.points[0]),
    points: stroke.points.slice()
  };

  // Draw the first point.
  drawDot(
    activeRemoteStrokes[stroke.id].lastPoint,
    stroke.color,
    stroke.width
  );
}

// A remote stroke sent more points.
function addRemotePoints(strokeId, points) {
  const stroke = activeRemoteStrokes[strokeId];
  if (!stroke) return;

  stats.remoteBatches += 1;
  stats.remotePoints += points.length;

  for (let i = 0; i < points.length; i++) {
    const point = toCanvasPoint(points[i]);

    // Draw only the new segment (no full redraw per message).
    drawSegment(stroke.lastPoint, point, stroke.color, stroke.width);
    stroke.lastPoint = point;
    stroke.points.push(points[i]);
  }
}

// A remote stroke is finished (a canvas-state redraw will follow).
function endRemoteStroke(strokeId) {
  delete activeRemoteStrokes[strokeId];
}

// ---------- Remote cursors ----------

function updateRemoteCursor(userId, x, y, color) {
  remoteCursors[userId] = { id: userId, x: x, y: y, color: color };
  drawRemoteCursors();
}

// Remove cursors of users who went offline.
function pruneRemoteCursors(activeUserIds) {
  Object.keys(remoteCursors).forEach(function (userId) {
    if (!activeUserIds.has(userId)) {
      delete remoteCursors[userId];
    }
  });
  drawRemoteCursors();
}

// Redraw the cursor layer (the drawing canvas is never touched).
function drawRemoteCursors() {
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

  Object.keys(remoteCursors).forEach(function (userId) {
    drawOneCursor(remoteCursors[userId]);
  });
}

// Draw one cursor: a small arrow in the user's color plus a label.
function drawOneCursor(cursor) {
  const point = toCanvasPoint(cursor);
  const c = cursorCtx;

  c.fillStyle = cursor.color;
  c.strokeStyle = cursor.color;
  c.lineWidth = 1.5;

  // Arrow head: a filled triangle with its tip at the cursor position.
  c.beginPath();
  c.moveTo(point.x, point.y);
  c.lineTo(point.x + 6, point.y + 14);
  c.lineTo(point.x - 10, point.y + 14);
  c.closePath();
  c.fill();

  // Arrow tail: a short line below the triangle.
  c.beginPath();
  c.moveTo(point.x, point.y);
  c.lineTo(point.x - 3, point.y + 24);
  c.stroke();

  // The user's id under the arrow.
  c.font = '11px Arial';
  c.fillText(cursor.id, point.x - 6, point.y + 40);
}

// Clear is global: main.js sends { type: 'clear' } and the server
// broadcasts an empty canvas-state that every browser redraws.