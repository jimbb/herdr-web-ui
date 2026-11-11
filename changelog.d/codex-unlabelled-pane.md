### Fixed
- Resolve Codex chats in panes where `herdr` has not yet set `pane.agent` (such as sessions
  resumed or handed off through a wrapper like `continues`) instead of returning 404
  `agent_not_found`, and fall back cleanly when Codex exits.
