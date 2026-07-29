# Player directives are delivered as best-effort whispers, not guaranteed overrides

Every action an agent-driven character takes flows through one choke point in
`agent-client`: `LlmBackend::send_message` (`watch.rs:158`) — the model's own
judgment call. There is no code path that executes an action without going
through the model first, so no amount of patching `agent-client` can make a
free-text player instruction *guaranteed* to be obeyed — only how prominently
it's presented to the model, which is a wording problem, not a code problem.

We considered bypassing the model entirely for directives: a narrow,
schema-forced translator call turns the instruction into one concrete action,
and the relay sends that action straight to the server on the agent's
connection, the same way it already forges frames for spectators. This would
be genuinely reliable, but it requires reimplementing a slice of
`driver/action.rs`/`execute.rs` (movement, attack, item-use encoding) in
JS — exactly the fast-moving, frequently-upgraded part of the protocol ADR
0001 deliberately avoided touching.

We chose best-effort instead: a Directive (see `CONTEXT.md`) is delivered as
a relay-forged `WhisperMessage`, which already carries `agent-client`'s
highest existing scheduling tier (`LlmPriority::Urgent`) and unconditional
prompt inclusion — no patch needed, no new protocol surface beyond what ADR
0001 already accepted. Reliability is bought back not through code that forces
compliance, but through visible verify-and-correct: the UI shows the
directive and the agent's very next action side by side, so a player sees
immediately whether it landed and can re-issue or rephrase if not.
