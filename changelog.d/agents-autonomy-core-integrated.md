### Added

- Agents keep a history of their AGENTS.md instructions and can restore an earlier version by its hash. Text with a saved secret is not kept.
- Agent memories keep their source (turn, review, reflection or manual) and their source thread, and each change to a memory's text is recorded so it can be reviewed. Forgetting a memory or clearing an agent's memories removes those records.
- Each agent consolidates its memories once a day. The run can be undone, and a second run on the same day does nothing.
- An agent that fails a turn saves one short lesson from that failure. The lesson holds no secret and is not in the essential memory set.
- A plan that the agent marks as done is checked by a second generation before the request ends. Gaps are shown to the agent for another turn.
- A failure that repeats three times in the last twenty turns of an agent is noted in the next turn.
- The agent can compute exact decimal arithmetic and boolean logic with compute_exact, and is told to use it for arithmetic.
- Irreversible actions (posting to a messaging thread, forgetting a memory, uninstalling a skill, deleting a routine or a workflow) wait for a person's approval of a preview.
- Memories from external messages are not shown to other messages until a person approves them.
- Search results for memories rank by relevance, then recency, then origin (manual first).
- A web search is recorded with its query and time, and a repeat search can find it.
- A person can see a proposal to move an agent memory to a channel or messaging memory, and approve or reject it.
- A wait can expire after a time limit, and a wait can name the routine whose runs wake it.
- A second provider checks an answer when the request asks to verify it, and a disagreeing check adds a note that lists the gaps.

### Changed

- Tool failures carry a code (validation, not_found, denied, approval_required, unavailable, timeout or internal) and a retry flag.
- An agent cannot change another agent's skills or routines without a person's message, and an agent cannot change its own routines or skills from a routine run.
- The limit of five hops applies to every message between agents, including messages that expect no reply.

### Fixed

- A message that an agent sends with send_message no longer keeps a secret that you saved: a saved secret stops the message, and a known secret pattern is masked before the message is stored.
- A script event that names a wait wakes only a run of the routine that the wait belongs to.
- The second-provider check of an answer shows at most five gaps, each cut to 200 characters with secrets removed, and stops after a minute when the second provider does not answer.
- An interrupt notice keeps the chain of the message it interrupts, so the next message the interrupted agent sends does not restart the hop count at 1.
- An agent cannot approve its own irreversible action through the local automation API, and cannot overwrite a memory that the user wrote.
