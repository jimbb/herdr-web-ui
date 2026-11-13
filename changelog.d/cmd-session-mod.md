### Fixed
- Command Code panes open in Chat again, including sessions started with `--continue`, `--resume`
  or `--session` and after `/clear`: herdr drops the session Command Code reports, so a small
  Command Code mod (`integrations/cmd-session.ts`, see the guide) names it for the pane's process.
