# Control Room · Live Terminals

Keep persistent agents visible together instead of losing them behind terminal tabs.
This live-terminal edition of Orca Control Room supports a configurable ordered roster.
Each tile renders the real
terminal stream with xterm.js and sends keyboard input directly to the existing Orca session.
Agents remain managed by Orca, including their conversation history and orchestration tools.

The live-terminal edition is the default on `main`. It keeps its own plugin ID, command,
port, browser storage, and state, separate from the earlier readable-text edition.
Existing live-terminal installations keep their pairing and layout when updating.

## Features

- One, eleven, or more independently connected terminals, with ANSI colors and native TUI redraws.
- Persistent lane names and order, searchable terminal selection, and add/remove controls.
- Automatic or fixed-column grids, per-lane resizing, maximize/restore, and adjustable text size.
- Direct typing, arrows, Enter, Escape, Ctrl+C, slash-command menus, and native command history.
- Native text selection and scrollback, with no conversation reconstruction or screen polling.
- A compact header, resizable tiles, and a maximize/restore button.
- Independent input queues, so a slow send to one terminal does not block the other.
- Output in one lane does not focus it or interrupt typing in the other lane.
- Reconnection restores Orca's terminal snapshot into the existing tile.
- Unavailable lanes show a warning and retain their last screen, with a **Reopen in Orca** action for the saved tab.
- Image paste/file selection stores a private local file and inserts its quoted path into the
  terminal prompt. Press Enter yourself to submit. Agent support for image paths still applies.
- Closing this view detaches its connections; it never sends a terminal close/kill command.

## Your layout

Open **Manage lanes** to add existing Orca terminals, give each lane a readable name, and
move it up/down in the roster. Order is **left to right, then the next row**. Saved order
does not depend on which terminal reconnects or replies first. Split panes in the same tab
have separate identities; an unavailable or ambiguous terminal is never silently replaced
by another agent. Terminal folder and shortened tab/pane IDs help distinguish duplicate names.

Choose **Auto** columns to adapt to the window, or pick 1–12 columns. The default tile height
fits up to two rows; additional rows scroll. Drag a tile's lower-right corner to resize it,
or maximize it from its header. **Reset sizes** returns custom tiles to the grid. Sizes follow
lane identities, not their left/right positions. Text size is adjustable from 9–20 px.

There is no requirement to use 11 agents: an empty room, one terminal, and larger rosters all
work. A 128-lane safety ceiling prevents accidentally opening unbounded connections; actual
practical capacity depends on your computer and the agents' output volume. Output is streamed,
not screen-polled. A short shared metadata cache avoids one roster request per connecting lane.

**Import original roster** adds available saved lanes from readable-text Control Room to
the current draft. It does not change the original installation. Save to apply, or Cancel
to discard roster changes. Removing a lane detaches its view only; the agent stays in Orca.

On Linux/Windows, **Ctrl+Shift+C** copies selected text, **Ctrl+Shift+V** pastes, and **Ctrl+C**
interrupts the agent. On macOS use **Cmd+C / Cmd+V** for clipboard actions. **Shift+Enter** sends
the same multiline fallback as Orca. Native slash-command menus, arrows, Enter, and Escape
remain available. The toolbar **Refresh** reloads this view without stopping your agents.

## Install and launch

Requires Node.js 20 or newer and npm. Clone this repository's `main` branch, then run in
the repository folder:

```bash
npm ci --omit=dev --ignore-scripts
npm run open
```

`npm run open` starts the live-terminal companion and opens a browser window. You can also add
this folder to Orca **Settings → Plugins → Development** and enable the
**Control Room · Live Terminals** plugin. Search for
**Control Room: Open Live Terminals** to launch it.

Enable only one development path for the live-terminal plugin. If you already installed
the experimental live edition from another checkout, update that checkout or replace its
development path with this folder rather than enabling duplicate copies. The earlier
readable-text edition has a different plugin ID and can remain installed alongside it.

## One-time local pairing

The live stream is behind Orca's authenticated WebSocket connection; the public plugin API
does not expose it. Generate a dedicated connection for this live view:

1. In Orca, open **Settings → Remote Orca Servers**.
2. Under **Share this Orca server**, choose **New Link**.
3. Choose **This computer only**, then generate and copy the runtime pairing link. A browser
   link containing the pairing information also works.
4. In the live Control Room window, open **Connection**, paste the link, and connect.
5. Use **Manage lanes** to select and arrange your existing Orca terminals.

The live edition rejects network addresses and phone-only pairings. It connects to loopback on
the same computer. A runtime pairing grants broad Orca runtime access: keep the link private,
and use a dedicated grant so it can be revoked without affecting other clients.

The pairing credential stays in the companion's private state directory. It is not sent to
the browser. Browser access uses a separate random token and exact-origin checks. No credentials,
terminal output, or agent roster are committed to this repository.

## Terminal sizing and reconnects

A terminal session has one underlying row/column size, even when Orca and Control Room both
show it. Attaching a tile initially observes the current size. Focusing or typing in a tile
claims its dimensions through Orca's viewport coordination. Resizing an unfocused tile does
not claim the terminal. The original Orca view may reflow when you use the smaller tile.

Focus-in and focus-out notifications are not keystrokes and do not trigger a jump to the
prompt. Typing and pasting still return to the bottom; normal terminal scrolling is unchanged.

The initial/reconnected scrollback is limited to the snapshot Orca provides. New output is
retained by xterm up to 10,000 lines. A reconnect replaces that view with a fresh snapshot.
Unconfirmed input is never automatically replayed; check the native prompt before resending it.

If Orca or its terminal daemon stops, a retained screen is **not** evidence of a live agent.
The header counts connected, writable terminal views separately from unavailable lanes;
“Live” does not mean the agent is currently working. Metadata is checked every 20 seconds
and on returning to the window; stream disconnects trigger an earlier check. Transport
heartbeats also detect dead connections. Unavailable lanes disable typing but keep their
last screen selectable for reference.

When Orca is reachable, **Reopen in Orca** opens that lane's exact saved tab and split pane
using Orca's normal desktop restore behavior. It may change the selected tab in Orca.
Control Room follows the restored terminal handle automatically, keeping the lane's name,
position, and size. The button never sends a prompt, invents a resume command, creates a
replacement tab, or kills another session. Orca controls whether a saved agent resumes;
if it returns a shell or needs confirmation, inspect that tab in Orca before proceeding.
An already-writable terminal only needs its view reconnected.

If Orca itself cannot be reached, start/reopen Orca first; Control Room retries its
connection without restarting agents. Missing or ambiguous saved tabs require selecting
the correct terminal in **Manage lanes**. A failed recovery is reported, not retried
automatically. This handles disconnection and recovery; it does not prevent Orca crashes.

This integration uses **internal Orca RPC**, not a stable terminal plugin API.
Protocol changes in stock Orca may require updating `companion/live-rpc.mjs` or the terminal
subscription adapter. No Orca fork, patched application, or tmux session is required.

## Isolation

| Item | Earlier readable-text edition | Live-terminal edition (`main`) |
| --- | --- | --- |
| Plugin ID | `tech0001/control-room` | `tech0001/control-room-live-terminals` |
| Port | `47831` | `47832` |
| State directory | `~/.config/orca-control-room` | `~/.config/orca-control-room-live-terminals` |
| Launcher | Open Director Console | Open Live Terminals |

On a fresh installation, the live edition reads the original roster once to seed its own roster.
Existing two-lane prototype settings migrate without replacing their selections or pairing.
It never writes the earlier edition's state or calls that companion's shutdown path.
Its image files are under its own `attachments` directory, with 24-hour expiry on subsequent
image uploads. Closing the live view leaves your Orca agent sessions running.

## Verification

```bash
npm ci --ignore-scripts
npm test
npm run test:live
```

The browser test uses system Chromium (`CHROMIUM_PATH` overrides `/usr/bin/chromium`) and an
isolated encrypted test runtime. It checks 0/1/2/11/14 lanes, persistent ordering and names,
split-pane identities, input routing, ANSI output, clipboard shortcuts, focus, scrollback,
reconnects, maximize/restore, authentication, and detach-only cleanup.
Recovery checks cover stale handles, missing PTYs, native saved-tab activation, disabled
offline input, metadata outages, concurrent clicks, and no automatic agent restarts.
These automated fixtures do not replace testing the adapter against the installed stock Orca
after pairing. The original readable-text renderer remains as reference code;
the default launcher uses `companion/live-server.mjs`.

MIT licensed. Dependencies retain their respective licenses.
