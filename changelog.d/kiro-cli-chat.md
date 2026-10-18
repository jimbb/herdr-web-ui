### Added
- kiro-cli (Amazon Kiro CLI) panes now have a chat view: their native session transcript
  (`~/.kiro/sessions/cli/<uuid>.jsonl`) is read into prompts, Markdown answers and per-turn work
  blocks like the other agents, and tool-approval menus (Allow / Always allow / Deny / Always
  deny) can be answered from the chat. A pane whose session cannot be identified unambiguously
  still shows its terminal.
