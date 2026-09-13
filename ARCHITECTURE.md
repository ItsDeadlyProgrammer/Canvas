# ARCHITECTURE — Collaborative Canvas

How the app is built, why it is built this way, and where its limits are.
This document describes the code as it is in **Step 6** (rooms + reconnection
+ validation + performance/touch polish). Steps 1–5 behavior (drawing,
cursors, users, global undo/redo/clear, late join, resize, rooms,
reconnection) is included and unchanged.

---

## 1. Architecture overview

One Node.js process, two servers sharing one HTTP port:

```
 Browser tab (xN)                      Node.js process
┌────────────────────┐            ┌──────────────────────────────┐
│ index.html         │   HTTP     │  Express  ── serves client/  │
│ style.css          │◄──────────►│            static files      │
│ canvas.js          │            │                              │
│ websocket.js       │   WS       │  ws WebSocketServer          │
│ main.js            │◄──────────►│  (same port, same server)    │
└────────────────────┘            │        │                      │
                                  │   server.js                     │
                                  │        │                        │
                                  │   rooms.js  (Map roomId→room)   │
                                  │        │                        │
                                  │   drawing-state.js (per room:   │
                                  │    history, redoStack,          │
                                  │    activeStrokes)               │
                                  └──────────────────────────────┘
```

Everything lives in RAM. There is no database, no Redis, no authentication,
no Socket.IO, no framework on the client — just vanilla JS + HTML5 Canvas
in the browser and Node.js + Express + `ws` on the server.

## 2. Client/server relationship

The **server owns all shared truth**:

* it assigns each connection its `userId` and display color (client-sent
  user ids are never trusted),
* it keeps the authoritative drawing state **per room**
  (`history`, `redoStack`, `activeStrokes`),
* it validates every incoming message before acting on it,
* it decides the order of operations (server arrival order),
* it sends `canvas-state` after every undo/redo/clear/stroke-end so every
  browser in the room converges to the same picture.

The client keeps a **read-only copy** of the server's operation list
(`operations` in `canvas.js`) and redraws from it whenever a `canvas-state`
arrives. Local strokes are drawn immediately for responsiveness, but the
copy is always replaced — never merged — when the server speaks.

## 3. WebSocket flow

### Client → server messages

| Message | Payload | Purpose |
| --- | --- | --- |
| `join-room` | `{ roomId }` | Join / switch rooms (also sent automatically on every connect/reconnect) |
| `stroke-start` | `{ stroke: { id, color, width, points[1] } }` | A stroke began |
| `stroke-points` | `{ strokeId, points[] }` | Batched intermediate points (requestAnimationFrame batching) |
| `stroke-end` | `{ strokeId }` | The stroke is complete → becomes ONE history operation |
| `cursor-move` | `{ x, y }` | Normalized (0..1) cursor position, throttled ~25/s |
| `undo` | — | Remove the room's latest completed operation |
| `redo` | — | Restore the latest undone operation |
| `clear` | — | Wipe the room's shared canvas (not undoable) |

### Server → client messages

Every message carries `roomId` (and `userId` where relevant):

| Message | Payload | When |
| --- | --- | --- |
| `welcome` | `{ roomId, user: { id, color } }` | After joining a room (connect, reconnect, switch) |
| `users` | `{ roomId, users: [{ id, color }] }` | Whenever a room's member list changes |
| `canvas-state` | `{ roomId, operations[], canUndo, canRedo, cleared? }` | The authoritative full state of a room; `cleared: true` marks the broadcast after CLEAR so clients also drop in-progress strokes |
| `stroke-start` / `stroke-points` / `stroke-end` | relayed from the drawing user | Real-time drawing |
| `cursor-move` | `{ userId, x, y }` | Remote cursor movement |

**Ordering per join:** a joining client receives `welcome` → `users` →
`canvas-state`, in that order, so the UI is fully consistent before the
first stroke can be sent.

## 4. Room architecture

`rooms.js` keeps a `Map` from `roomId` to a room object:

```
Room
 ├── id:        'room-red'
 ├── clients:   Set<WebSocket>      ← ONLY these sockets receive broadcasts
 ├── users:     { userId: { id, color } }
 └── state:     createDrawingState() ← history / redoStack / activeStrokes
```

Every broadcast (`broadcastToRoom`) iterates **only the room's `clients`**.
That single rule produces all isolation properties:

* strokes, points, stroke-ends → only same-room sockets
* cursors → only same-room sockets
* `users` lists → only same-room sockets
* `canvas-state` (undo/redo/clear/stroke-end resync) → only same-room sockets
* late-join snapshot → only that room's state

The server re-tags every relayed message with the server-side `userId` and
the room's `roomId`; clients use these fields to ignore anything that does
not belong to the room they are currently in (guard in `main.js`).

## 5. Room lifecycle

1. **Created lazily** — the first time a client joins a room id
   (`getRoom` creates it with a fresh empty drawing state).
2. **Joined** — `join-room` (or the automatic default join on connect):
   validate id → remove client from old room → add to new room →
   `welcome` + `users` + `canvas-state`.
3. **Left / emptied** — when the last client leaves (switch, disconnect),
   the room **stays in memory with its drawing**. A room's canvas is shared
   state that belongs to the room, not to whoever is online; a user who
   switches away and comes back must find it unchanged.
4. **Destroyed** — only when the server process exits. There is no
   garbage collection of rooms while the server runs (an accepted,
   documented limitation).

Default room: `default-room` — every fresh connection auto-joins it
immediately, so the app works before the user ever touches the Room input.

## 6. Drawing state (per room)

`drawing-state.js` is a factory; each room calls it once and gets three
collections plus the operations on them:

| Collection | Contents | Grown by | Shrunk by |
| --- | --- | --- | --- |
| `history` | completed operations, oldest first | `endStroke`, `redo` | `undo`, `clearAll` |
| `redoStack` | undone operations, newest first | `undo` | `redo`, `clearAll`, new `endStroke` |
| `activeStrokes` | in-progress strokes by stroke id | `startStroke`, `addStrokePoints` | `endStroke`, `clearAll`, user left/disconnected |

Key rules:

* **One completed stroke = one history operation**, no matter how many
  points it has (a 500-point stroke is still a single op).
* A **new stroke empties the redo stack** (standard undo/redo semantics:
  you cannot redo across new work).
* A stroke that never receives `stroke-end` **never enters history** —
  when a user disconnects or switches rooms mid-stroke, the server drops
  their active strokes (`removeActiveStrokesByUser`) and, if any were
  removed, broadcasts a fresh `canvas-state` so the partial pixels
  disappear from every remaining client's canvas as well.
* `clearAll` wipes all three collections and is **not undoable** (documented
  in the README).

## 7. Global undo/redo (per room)

Undo/redo are **global within a room** by design (Step 4 decision, kept):

```
history: [..., opN-1, opN]     redoStack: []
   │ undo: pop opN → redoStack      history: [..., opN-1]   redoStack: [opN]
   │ redo: pop opN → history        history: [..., opN-1, opN] (back)
```

Whichever user in the room clicks Undo, the room's latest completed stroke
disappears for **everyone in that room**. After every undo/redo/clear the
server broadcasts a fresh `canvas-state` to the whole room (including the
initiator), so all browsers converge instantly and the
`canUndo`/`canRedo` button states come from the server, not from guesses.

## 8. Late-join synchronization

When a client joins a room, the server sends it `makeCanvasStateMessage(room)`:
the room's full `history`, plus `canUndo`/`canRedo`. The client
(`applyCanvasState`) **replaces** its local operations with that list and
redraws the whole canvas. Late joiners therefore see exactly the room's
current picture — and nothing from any other room.

## 9. Reconnection flow

Client side (`websocket.js`):

```
socket closes unexpectedly
  → cancelLocalStroke()        (drop half-finished stroke; it never resumes)
  → status = "Reconnecting..." (amber dot; the app never crashes)
  → scheduleReconnect()        delay = min(1000 · 2^attempt, 10s)
                               → 1s, 2s, 4s, 8s, 10s, 10s, ...
socket reopens
  → attempts reset, status = "Connected"
  → send { type: 'join-room', roomId: currentRoomId }   (room id preserved)
server
  → assigns a FRESH userId + color, sends welcome → users → canvas-state
client
  → replaces its operations with the fresh canvas-state, redraws
```

Backoff is deliberately capped at 10 s so a long outage produces a gentle
retry loop instead of hammering the server. The `currentRoomId` is kept in
`websocket.js`, so a reconnect re-joins the same room automatically — even
if the user joined it right before the connection dropped.

The server is **authoritative after reconnection**: whatever the client
drew while offline is gone (the server never saw it), and whatever the room
gained while the client was away arrives in the fresh `canvas-state`.

## 10. Room switching

Client (`main.js` → `switchRoom`):

1. forget the old room's visuals (`resetRoomDrawing` clears operations,
   active remote strokes, remote cursors, and any local in-flight stroke),
2. send `join-room` (the new room id is also remembered for reconnects),
3. update the sidebar label optimistically,
4. receive `welcome` + `users` + `canvas-state` for the new room, redraw.

Server (`joinRoom`):

1. remove the client from the old room's `clients`/`users`,
2. drop the user's unfinished active strokes in the old room,
3. broadcast the old room's `users` to whoever remains,
4. add the client to the new room (created if needed), pick a color,
5. send `welcome` + `users` + `canvas-state`.

A stale `canvas-state` that races a switch is ignored by the client
(`message.roomId !== getCurrentRoomId()` guard). Switching back to a
previously visited room restores its state because rooms persist (§5).

## 11. Validation

Defense happens at several layers. No external validation library.

| Layer | Rule |
| --- | --- |
| WebSocket frame | `maxPayload: 128 KB` — `ws` closes any connection sending more |
| JSON | unparsable payloads ignored; only plain objects accepted (rejects `null`, arrays) |
| Message type | unknown types ignored (allow-list of 8 types) |
| Room membership | every non-`join-room` message requires an active room |
| Room id | string, 1–32 chars, `/^[a-zA-Z0-9_-]+$/` |
| Stroke id | string, 1–60 chars |
| Color | `#rrggbb` hex pattern |
| Width | finite number, 0.1–100 |
| Points | array, 1–200 items, each `{x,y}` finite numbers in 0..1 |
| Cursor | `{x,y}` finite numbers in 0..1 |
| Identity | `userId` always comes from the socket (`clientSocket.userId`), never from the payload |
| Half-finished work | `stroke-points`/`stroke-end` for unknown stroke ids ignored; a leaver's active strokes are deleted |
| Duplicate stroke-start | a second `stroke-start` for an id that is already active is rejected — the first stroke owns the id, so nothing is reset or broadcast twice |

Invalid input is logged and dropped; the server never throws on bad input
and stays available to all other clients.

## 12. Performance model

The pipeline, in one line:

```
Pointer event → local render → requestAnimationFrame batch → WebSocket
             → server (validated) → other clients → incremental render
```

* **Local drawing is rendered immediately.** The user's own stroke appears
  on the canvas the moment a pointer event arrives; it never waits for a
  WebSocket round trip.
* **Pointer points are batched using requestAnimationFrame.** Pointer moves
  collect normalized points into `pendingPoints`; one `stroke-points`
  message is flushed per animation frame instead of one message per move.
  The message rate is bounded by the frame rate, while real-time feel is
  preserved (remote users see the stroke grow live). If one frame collects
  more than the server's 200-point batch limit, the client splits the
  pending points into several messages so nothing is silently dropped by
  validation.
* **Point reduction** — before a point is accepted, its distance to the
  previously accepted point is measured in CSS pixels; samples closer than
  2px are ignored. A high-rate pointer emitting hundreds of nearly
  identical moves adds (almost) no traffic, memory, or redraw cost, while
  2px keeps the drawing visually exact. (Measured in Step 6: 300
  sub-threshold pointer moves produced 0 sent points.)
* **Remote active strokes are incrementally rendered.** A `stroke-start`
  creates an active-remote-stroke entry; `stroke-points` draws only the
  newly received segments; `stroke-end` finalizes the operation. The
  canvas is never rebuilt per message.
* **Full canvas redraws happen only when authoritative state changes or
  the canvas needs to be reconstructed** — `canvas-state` (join,
  reconnect, undo/redo/clear, stroke-end) and window resize. Full redraws
  replay `operations` (O(ops) per event — fine at this scale and it
  removes an entire class of sync bugs). In-progress strokes (local +
  remote) are re-drawn on top of the operations during a redraw so a
  `canvas-state` that arrives mid-stroke cannot erase pixels being drawn.
* **Coordinates are normalized (0..1) so resizing does not destroy
  drawings** — a resize just re-replays the same normalized operations at
  the new pixel size.
* **Cursor updates are throttled** — cursor positions are sent at most
  every 40 ms (~25 updates/second), never on every raw pointer move.
* **Two-layer canvas** — remote cursors live on a separate transparent
  `<canvas>` with `pointer-events: none`, so cursor movement never damages
  the drawing and never triggers pointer events.

Measured during the Step 6 run (headless Chrome 1280×800, localhost):
stroke-end → `canvas-state` for a 1001-point stroke: 2–4 ms (avg 3 ms);
full redraw ~0.3 ms with one stroke, ~0.9 ms with ~16 strokes on the
canvas. `window.__canvasStats` (press `i` in the UI) exposes these
counters for development.

## 13. Conflict-resolution strategy

**Completed drawing operations are ordered by server arrival order.**

The server appends an operation to a room's `history` at the moment its
`stroke-end` message arrives; the resulting order is the single shared
truth that every client replays. There is no per-client interleaving,
no vector clocks, no merging: for concurrent strokes, whoever's `stroke-end`
the server saw first is earlier in the history. The same arrival-order rule
applies to `undo` / `redo` / `clear` — they are processed one at a time in
message arrival order, and each one immediately broadcasts the resulting
authoritative state.

**This is not CRDT or OT.** There is no concurrent-edit merge model. Two
users drawing at the same time do not get per-character (or per-stroke)
intention merging — they get a deterministic, server-chosen total order.
Global undo removing "the latest stroke, whoever drew it" is a direct and
intended consequence.

## 14. Why CRDT/OT is not used

* The assignment explicitly forbids them and demands simple,
  interview-explainable design.
* A shared freehand canvas does not need text-merge semantics; a single
  ordered list of completed strokes is a natural model.
* Server-authoritative ordering is ~50 lines of plain JavaScript
  (`drawing-state.js`), trivially testable, deterministic, and easy to
  reason about — CRDT/OT would add substantial complexity for a benefit
  this application does not need.
* The known trade-off (server-ordered history instead of intention
  preservation) is acceptable and documented here and in the README.

## 15. Current scalability limitations

* **In-memory only** — a server restart wipes every room; no persistence.
* **Rooms are never garbage-collected** while the server runs — many
  distinct room ids grow the map unbounded (bounded only by the 32-char
  id rule, not by count).
* **Single process, single port** — no clustering; `history` grows without
  bound as users draw (each op is kept forever for undo/late-join).
* **Full-canvas redraw** per `canvas-state` is O(total operations) — fine
  for hundreds of ops, would need incremental diffs at much larger scale.
* **No rate limiting or auth** — validation caps message size and value
  ranges, but a client can still send many valid messages quickly.
* **Palette reuse** — rooms with more than 6 simultaneous users reuse
  colors.
* **No horizontal scaling** — two server instances would not share rooms
  (no pub/sub layer, deliberately).

## 16. Scalability note (not implemented)

The architecture above is deliberately simple enough to explain in an
interview. One consequence: **the current server broadcasts every message
to all clients within a room** (and every `canvas-state` replays the
room's whole history). That is suitable for the assignment's scale, but a
room with hundreds or 1000+ users would need optimization. Possible
future improvements — none of which are implemented here — include:

* stronger room infrastructure (room sharding, per-room limits),
* pub/sub between server instances (Redis-style) for multi-process rooms,
* connection/load balancing in front of the WebSocket servers,
* message batching/coalescing on the server side,
* rate limiting per connection,
* persistence (rooms currently live and die with the process),
* more efficient fan-out (delta updates instead of full `canvas-state`,
  compressed point batches),
* possibly spatial/region-based updates (clients subscribe to the canvas
  region they are looking at).