### Fixed
- An agent that reports its own turn stopped on an error (herdr-core's `error` state, as agy does
  when its agent executor stops) now rests as idle and sends the "Stopped on an error" alert to
  devices that asked for it, instead of reading as unknown with no alert at all.
