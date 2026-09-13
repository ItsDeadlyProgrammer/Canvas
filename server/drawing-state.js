// drawing-state.js
// Server-authoritative drawing state for one room:
//   history       - completed operations (server arrival order)
//   redoStack     - operations removed by undo, waiting for redo
//   activeStrokes - strokes being drawn (no stroke-end yet)

function createDrawingState() {
  // Completed operations, oldest first.
  // One entry: { type: 'stroke', stroke: { id, userId, color, width, points } }
  const history = [];

  // Operations removed by undo, newest first.
  const redoStack = [];

  // Strokes being drawn (stroke-start seen, stroke-end not yet), by stroke id.
  const activeStrokes = {};

  // A new stroke began. Returns false if the stroke id is already active
  // (the first stroke-start owns the id).
  function startStroke(stroke, userId) {
    if (activeStrokes[stroke.id]) return false;

    activeStrokes[stroke.id] = {
      stroke: {
        id: stroke.id,
        userId: userId,               // identity comes from the server
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.slice() // copy the points array
      }
    };
    return true;
  }

  // Add points to an in-progress stroke. Returns false if unknown.
  function addStrokePoints(strokeId, points) {
    const active = activeStrokes[strokeId];
    if (!active) return false;
    active.stroke.points = active.stroke.points.concat(points);
    return true;
  }

  // The stroke is complete: ONE history operation, redo stack cleared.
  // Returns the new operation, or null if the stroke was unknown.
  function endStroke(strokeId) {
    const active = activeStrokes[strokeId];
    if (!active) return null;

    const operation = { type: 'stroke', stroke: active.stroke };
    delete activeStrokes[strokeId];

    history.push(operation);

    // Standard undo/redo rule: new work empties the redo possibilities.
    redoStack.length = 0;

    return operation;
  }

  // Undo the LATEST operation: move it from history to redoStack.
  // Returns the undone operation, or null when history is empty.
  function undo() {
    if (history.length === 0) return null;
    const operation = history.pop();
    redoStack.push(operation);
    return operation;
  }

  // Redo the latest undone operation: move it back to history.
  // Returns the redone operation, or null when redoStack is empty.
  function redo() {
    if (redoStack.length === 0) return null;
    const operation = redoStack.pop();
    history.push(operation);
    return operation;
  }

  // Wipe everything. Clear is NOT undoable (documented in the README).
  function clearAll() {
    history.length = 0;
    redoStack.length = 0;
    Object.keys(activeStrokes).forEach(function (strokeId) {
      delete activeStrokes[strokeId];
    });
  }

  // Remove a leaver's half-finished strokes. Returns how many were
  // removed (the caller redraws the room when it is > 0).
  function removeActiveStrokesByUser(userId) {
    let removed = 0;
    Object.keys(activeStrokes).forEach(function (strokeId) {
      if (activeStrokes[strokeId].stroke.userId === userId) {
        delete activeStrokes[strokeId];
        removed += 1;
      }
    });
    return removed;
  }

  function getHistory() {
    return history;
  }

  function getRedoLength() {
    return redoStack.length;
  }

  return {
    startStroke: startStroke,
    addStrokePoints: addStrokePoints,
    endStroke: endStroke,
    undo: undo,
    redo: redo,
    clearAll: clearAll,
    removeActiveStrokesByUser: removeActiveStrokesByUser,
    getHistory: getHistory,
    getRedoLength: getRedoLength
  };
}

module.exports = createDrawingState;