### Added

- An agent can propose that one of its memories becomes the memory of the channel or chat it answers in. The proposal shows as an approval card for the person. Only the server owner, the person at this computer, or a press of the person in the chat can approve it. Nothing is saved to the shared memory until then.

### Changed

- A wait that an agent opens with `await_event` closes by itself after 24 hours, and a wait opened in a routine run wakes only for runs of that routine. Before, such a wait stayed open until the agent closed it, and any routine run woke it.
