// rooms.js
// Tiny in-memory room manager. A room looks like:
//   { id, clients: Set<WebSocket>, users: { userId: { id, color } }, state }
//
// A room is created on first join and stays in memory (with its drawing)
// until the server restarts, so coming back later finds it unchanged.
// Every broadcast is scoped to a room's clients, which is what isolates
// rooms from each other.

const createDrawingState = require('./drawing-state');

// roomId -> room object
const rooms = new Map();

// Get a room, creating it on first use.
function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      clients: new Set(),
      users: {},
      state: createDrawingState()
    };
    rooms.set(roomId, room);
  }
  return room;
}

module.exports = {
  getRoom: getRoom
};