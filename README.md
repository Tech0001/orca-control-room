# Control Room · Live Terminals

An experimental two-terminal version of Orca Control Room. Each tile renders the real
terminal stream with xterm.js and sends keyboard input directly to the existing Orca session.
Agents remain managed by Orca, including their conversation history and orchestration tools.

This branch is `experiment/live-terminals`. Keep it in a separate folder from your working
Control Room installation. It has its own plugin ID, command, port, browser storage, and state.

## What works in the prototype

- Two independently connected live terminals, with ANSI colors and native TUI redraws.
- Direct typing, arrows, Enter, Escape, Ctrl+C, slash-command menus, and native command history.
- Native text selection and scrollback, with no conversation reconstruction or screen polling.
- A compact header, resizable tiles, and a maximize/restore button.
- Independent input queues, so a slow send to one terminal does not block the other.
- Output in one lane does not focus it or interrupt typing in the other lane.
- Reconnection restores Orca's terminal snapshot into the existing tile.
- Image paste/file selection stores a private local file and inserts its quoted path into the
  terminal prompt. Press Enter yourself to submit. Agent support for image paths still applies.
- Closing this view detaches its connections; it never sends a terminal close/kill command.

## Run alongside stable Control Room

Requires Node.js 20 or newer and npm. In this experimental checkout:

```bash
npm ci --omit=dev --ignore-scripts
npm run open
```

`npm run open` starts the experimental companion and opens a browser window. You can also add
this folder to Orca **Settings → Plugins → Development** and enable the separate
**Control Room · Live Terminals (Experimental)** plugin. Search for
**Control Room: Open Live Terminals (Experimental)** to launch it.

Do not replace the stable plugin's development path with this one. Both can be installed.

## One-time local pairing

The live stream is behind Orca's authenticated WebSocket connection; the public plugin API
does not expose it. Generate a dedicated connection for this experimental view:

1. In Orca, open **Settings → Remote Orca Servers**.
2. Under **Share this Orca server**, choose **New Link**.
3. Choose **This computer only**, then generate and copy the runtime pairing link. A browser
   link containing the pairing information also works.
4. In the experimental Control Room window, open **Connection**, paste the link, and connect.
5. Use **Choose two lanes** to select two different existing Orca terminals.

The prototype rejects network addresses and phone-only pairings. It connects to loopback on
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

The initial/reconnected scrollback is limited to the snapshot Orca provides. New output is
retained by xterm up to 10,000 lines. A reconnect replaces that view with a fresh snapshot.
Unconfirmed input is never automatically replayed; check the native prompt before resending it.

This is a local experiment using **internal Orca RPC**, not a stable terminal plugin API.
Protocol changes in stock Orca may require updating `companion/live-rpc.mjs` or the terminal
subscription adapter. No Orca fork, patched application, or tmux session is required.

## Isolation

| Item | Stable Control Room | Experimental live view |
| --- | --- | --- |
| Plugin ID | `tech0001/control-room` | `tech0001/control-room-live-terminals` |
| Port | `47831` | `47832` |
| State directory | `~/.config/orca-control-room` | `~/.config/orca-control-room-live-terminals` |
| Launcher | Open Director Console | Open Live Terminals (Experimental) |

The experiment reads the first two names from the stable roster once to seed its own roster.
It never writes stable state or calls the stable companion's shutdown path.
Its image files are under its own `attachments` directory, with 24-hour expiry on subsequent
image uploads. Disable this plugin and close its window to return to the stable version.

## Verification

```bash
npm ci --ignore-scripts
npm test
npm run test:live
```

The browser test uses system Chromium (`CHROMIUM_PATH` overrides `/usr/bin/chromium`) and an
isolated encrypted test runtime. It checks two real xterm renderers, input routing, ANSI output,
focus, scrollback, reconnects, maximize/restore, authentication, and detach-only cleanup.
These automated fixtures do not replace testing the adapter against the installed stock Orca
after pairing. The original readable-text renderer remains in this branch as reference code;
the experimental launcher uses `companion/live-server.mjs`.

MIT licensed. Dependencies retain their respective licenses.
