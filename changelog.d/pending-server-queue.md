### Fixed
- Keep server-queued follow-up messages in `queued` state across transient browser WebSocket disconnects and reloads so the server delivers them automatically when the current agent turn finishes, and rebind waiting or guard-held follow-ups to the returning browser connection on reattach.
