### Fixed
- On an iPhone or iPad, a terminal no longer stays drawn with every letter spread apart and its
  words over each other after going back from Chat to Terminal while another device had the pane
  at another size: libghostty's layer takes xterm's cell size instead of the screen's width over
  a grid it has not drawn yet.
