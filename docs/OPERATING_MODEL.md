# Operating model

Orca Control Room is designed for a persistent agent organization, not a queue of disposable
tasks.

## Layers

1. **Director** — the human who sets priorities, resolves conflicts, and owns final decisions.
2. **Strategists** — long-lived agents that maintain the program map, architecture, sequencing,
   and risk picture.
3. **Department managers** — long-lived specialist agents that own bounded technical domains and
   retain the working context for those domains.
4. **Workers** — short-lived agents created by a manager for isolated implementation, research,
   or verification. Their conclusions return to the manager instead of becoming another permanent
   top-level lane.

The Control Room keeps strategists and managers spatially stable. Worker counts and alerts roll up
to their owning lane.

## Coordination rules

- A strategist may propose cross-department direction but does not silently rewrite a department's
  technical invariants.
- Managers delegate bounded work to workers and require evidence-backed summaries before accepting
  it into their durable state.
- Cross-lane changes name both sides of the interface and record who accepted the change.
- The Director sees unread state and blockers in the Control Room, while status metadata never
  removes an idle long-lived lane from view.
