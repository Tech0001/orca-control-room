# Orca Control Room

A persistent director console for people running a long-lived organization of agents in
[Orca](https://www.onorca.dev/).

Unlike a task dashboard, Control Room keeps planning strategists and department managers visible
even when they are idle. Short-lived workers roll up beneath their manager instead of taking over
the primary view.

## Current prototype

- Runs alongside stock Orca and uses only the public `orca` CLI.
- Pins a stable roster across Orca restarts, rebinding runtime terminal handles automatically.
- Re-reads every selected terminal's rendered screen every two seconds and rolls changed
  frames into a bounded lane history.
- Adds terminal-style highlighting to the plain-text terminal data exposed by Orca's public CLI.
- Groups prompts, replies, tool activity, and thinking into labeled conversation blocks.
- Replaces animated thinking redraws in place instead of repeating them in lane history.
- Preserves the last readable frame during transient failures and flags the lane while retrying.
- Keeps a bounded rolling lane history so short post-send frames cannot collapse the scrollbar.
- Preserves reading position and offers a **New output** jump when a lane changes above the fold.
- Opens retained terminal history on demand.
- Waits for Orca's verified agent-prompt delivery result and displays failures without clearing
  the Control Room input.
- Sends a message or jumps directly to the native Orca terminal.
- Persists lane names, strategist/manager roles, order, and column count.
- Supports persistent per-lane resizing without changing the underlying PTY dimensions.
- Binds only to `127.0.0.1` and protects its local API with a random session token.
- Replaces an outdated companion automatically when a newer plugin version opens.

## Install as a development plugin

1. In Orca, open **Settings → Plugins** and enable the plugin system.
2. Under **Development plugins**, add this repository folder.
3. Review and enable **Orca Control Room**. The plugin contains a trusted Node worker because it
   launches the local companion process.
4. Open **Search** (`Ctrl+J` on Linux), search for **Control Room**, and run
   **Control Room: Open Director Console**.
5. Choose **Manage lanes**, add the long-lived terminals, assign roles, and save the layout.

On Linux, the launcher opens Chromium in app mode when available and falls back to the default
browser. The companion exits after ten minutes without an open client.

## Run without installing the plugin

```bash
npm start
```

Then open `http://127.0.0.1:47831/?token=development-only-token`.

## Validate

```bash
npm test
```

The operating and memory model is documented in [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md).

## Status

This is an early local prototype. It intentionally avoids Orca's private terminal stream protocol
so it remains compatible with stock app updates. The tradeoff is a readable text representation
of each terminal rather than embedding Orca's exact native xterm component.
