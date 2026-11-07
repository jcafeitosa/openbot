### Added

- A wait that an agent opens in a routine's thread wakes once when a later turn of that thread completes successfully. The agent's next prompt carries a note that OpenBot wrote itself, and the note names no sender. A failed or stopped turn does not wake the wait.
