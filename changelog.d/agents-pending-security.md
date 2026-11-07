### Changed

- An agent's proposal to change its instruction file, or to add a skill, is offered to you only after the agent has 20 recorded turns. Before, a new agent's change had no history to be checked against, so it could be approved with no evidence. The agent sees why its proposal was not offered.
- A skill draft installs only the files that you saw on its card. If a file in the skill folder changes after the card appears, OpenBot stops the install and installs nothing. Read the folder, then have the agent propose the draft again.
- The card that removes an agent's instruction file shows the text that the removal deletes, with secrets redacted. A text too big for one card, over 8 KB, is refused.

### Fixed

- A roster save that gives the same thread to a second agent now fails and keeps the thread with its own agent. Before, the thread moved silently, and the first agent's conversation showed under the second agent.
