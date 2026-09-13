# 🎨 Collaborative Canvas

## Live Demo
Link : https://canvas-37ew.onrender.com/

## Overview
A real-time collaborative drawing canvas built with **only** vanilla JavaScript.

- **Rooms** — users in different rooms never see each other's drawings,
  cursors, or user lists
- **Reconnection** — if the socket drops, the client reconnects automatically
  with a 1s → 2s → 4s → … backoff (capped at 10s)
- **Room-scoped undo/redo/clear** — undo only affects the room you're in
- **Room switching** — change rooms through the toolbar
- **Stronger server validation** — malformed messages never crash the server
- **Performance (Step 6)** — local-first drawing, requestAnimationFrame point
  batching (split into server-sized batches), a 2px point-reduction
  threshold, incremental remote rendering, full redraws only when the
  authoritative state changes
- **Touch / stylus support (Step 6)** — Pointer Events (mouse, touch,
  stylus) with `touch-action: none`
- **Simultaneous-drawing hardening (Step 6)** — duplicate `stroke-start`
  messages are ignored, in-progress strokes survive full redraws, and
  someone who disconnects mid-stroke is cleaned up on every client
- **Development metrics (Step 6)** — a hidden stats overlay (press `i`)
  showing points, batches, redraw counts and redraw time
- **UI polish (Step 6)** — the toolbar wraps on narrow screens and controls
  shrink for mobile widths

## Tech stack 

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Browser  | Vanilla JavaScript, HTML, CSS       |
| Drawing  | Native HTML5 Canvas API             |
| Server   | Node.js + Express                   |
| Realtime | `ws` (WebSocket library)            |

## Run it

```bash
# 1. Install dependencies (first time only)
npm install

# 2. Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

## How to choose / join a room

The toolbar has a **Room** input. The default room is `default-room`. To join
a different room, type its name and click **Join**:

```
Room: [ my-room ] [Join]
```

- Room IDs must be **1–32 characters**
- Allowed characters: letters, numbers, `-`, `_` (anything else is rejected
  by both the client and the server)
- Each room has its own independent drawing, users, cursors, and
  undo/redo history

## How to test with two or more users

1. `npm start`, then open **two or more windows/tabs** at http://localhost:3000.
2. Windows **A** and **B** both join `room-red` (type `room-red`, click Join).
3. **A** draws → **B** sees the stroke appear in real time.
4. Open a third window **C**, join `room-blue` → **C** does NOT see **A**'s
   strokes (and **A/B** do not see **C**'s).
5. **A** clicks **Undo** → only `room-red` is affected; `room-blue` is untouched.
6. **A** clicks **Clear** → only `room-red` is cleared.
7. **C** joins `room-red` later → receives the full `room-red` canvas (late join).
8. **A** switches to `room-blue` → the blue room's drawing appears; red is hidden.
9. Move the mouse inside **A**'s canvas → **B** sees **A**'s cursor; **C** does not.
10. Kill the server (Ctrl+C) → clients show **Reconnecting...**, then reconnect
    automatically when it's back and resynchronize from the server.

The connection indicator (top-right of the toolbar) shows one of three states:

```
● green   Connected
● orange  Reconnecting...
● red     Disconnected
```

## Reconnection behavior

- When the WebSocket closes unexpectedly, the client:
  1. updates the indicator to **Reconnecting...** (it never crashes),
  2. keeps the current room id,
  3. retries with backoff: 1s, 2s, 4s, 8s, … capped at 10s.
- When the connection comes back, the client automatically re-joins its room
  and the **server** sends a fresh `welcome`, `users`, and `canvas-state`.
  The client **replaces** its local operation state with that `canvas-state`
  and redraws — the server is the source of truth after a reconnect.
- If you were drawing when the connection dropped, that half-finished stroke
  is discarded (the server cleans it up too). An unfinished stroke is never
  turned into a permanent history operation, and it is not resumed across a
  broken connection — this is intentional.

> Note: state is in-memory only. Restarting the server empties every room —
> that is expected at this step (persistence is a later step). Reconnection
> is about re-syncing with the server, not about surviving a server wipe.

## Room isolation (reminder)

```
Room red         Room blue
  ├── A              ├── C
  ├── B              └── C's drawing
  └── drawing        └── undo/redo history
```

A stroke, cursor, user-list change, undo, redo, or clear in one room is never
broadcast to another room. Late joiners of `room-red` receive only `room-red`'s
canvas.

## What "global" undo means

Undo/redo are **global within a room** — they affect the whole shared canvas in
that room, not just your own strokes:

```
1. A draws A1
2. B draws B1
3. A clicks Undo   -> B1 disappears (the LATEST completed stroke)
4. B clicks Undo   -> A1 disappears
5. B clicks Redo   -> A1 comes back
```

Whichever user in the room clicks Undo, the same latest stroke is removed for
**everyone in that room**. Clear is intentionally **not** undoable, and undo
is not per-user (see limitations).

## Performance behavior

- **Local drawing is immediate** — your own stroke appears on the canvas at
  once; it never waits for a WebSocket round trip.
- **Point batching** — many pointer events are collected and flushed as ONE
  `stroke-points` message per animation frame. If a batch would exceed the
  server's 200-point limit, the client splits it into several messages so
  nothing is silently dropped.
- **Point reduction** — pointer samples closer than **2 CSS pixels** to the
  previously accepted point are ignored. High-rate mice/styluses emitting
  hundreds of nearly identical moves produce (almost) no extra traffic.
- **Remote strokes render incrementally** — incoming `stroke-points` draw
  only the new segment; the canvas is never rebuilt per message.
- **Full redraws are rare** — the canvas is rebuilt only when the
  authoritative state changes (`canvas-state` on join/reconnect/undo/redo/
  clear/stroke-end) or when the window resizes. Everything uses normalized
  coordinates, so a resize just replays the operations.
- **Cursors are throttled** to at most ~25 updates/second.
- **Development metrics** — press **`i`** (outside the room input) to toggle
  a small "dev stats" box in the sidebar: points/batches sent and received,
  approximate batches/s, stroke count, full-redraw count and the duration
  of the last full redraw (`window.__canvasStats` is also readable in the
  browser console).



## Touch and stylus support

Drawing uses **Pointer Events** (`pointerdown` / `pointermove` /
`pointerup` / `pointercancel`), so mouse, touch and stylus all work through
the same code path. The canvas has CSS `touch-action: none`, so touch
drawing never scrolls or zooms the page.

Touch was not checked on a physical phone or tablet during development —
only in a desktop browser — but mouse and touch share the exact same
Pointer Events code path.

## Simultaneous drawing

Two (or more) users can draw at the same time. Every stroke stays an
independent operation, and **completed drawing operations are ordered by
server arrival order** — there is no merge logic (no CRDT/OT). Global
undo/redo/clear also process in arrival order, so every client converges to
the same deterministic state.



## Project structure

```
collaborative-canvas/
├── client/                  ← everything the browser loads (static)
│   ├── index.html           UI skeleton: toolbar, two canvases, sidebar
│   ├── style.css            layout, connection indicator, dev-stats box
│   ├── canvas.js            drawing, point batching/reduction, redraws
│   ├── websocket.js         connect/reconnect, send/receive, room memory
│   └── main.js              glue: toolbar wiring + message router
├── server/                  ← Node.js side
│   ├── server.js            Express + ws, validation, broadcast, rooms glue
│   ├── rooms.js             in-memory room manager (Map roomId → room)
│   └── drawing-state.js     per-room history / redoStack / activeStrokes
├── package.json             scripts + dependencies (express, ws only)
└── ARCHITECTURE.md          how it all fits together
```

## Future improvements

Not implemented (kept simple on purpose — see ARCHITECTURE.md
"Scalability note" for the full discussion): persistence, authentication,
rate limiting, horizontal scaling with pub/sub between server instances,
delta fan-out instead of full `canvas-state` broadcasts, and
spatial/region-based updates for very large rooms.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how it all fits together.
