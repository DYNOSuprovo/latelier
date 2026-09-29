# Destructive friction follows blast radius, not reversibility

How hard a destructive action is to trigger did not follow how much it destroys. Dropping an index, collection, database or user required typing the name to confirm, but deleting a saved connection — which also drops its saved queries and history, unrecoverably — was one click. Deleting an aggregation stage — the user's in-progress editor state, trivially reproducible — was instant with no confirm and no undo at all. Three surfaces, three unrelated frictions, none of them chosen for the reason that mattered.

**Decision.** Two tiers, decided by what is destroyed rather than by whether the outcome happens to be undoable:

- **Type-to-confirm** for anything that destroys server data by filter or by container (dropping a collection/database/user, deleting all documents matching a filter), and for anything that irreversibly destroys local persisted data (deleting a saved connection, which cascades to its saved queries and history). The user types the name back before the action fires.
- **Instant + Undo toast** for local editor state that isn't persisted yet — an aggregation stage removed from the pipeline builder, for example. No confirm; the action fires immediately and the toast's Undo action reverses it.

Being reversible never moves an action down to the lighter tier by itself. An audited write can be undone, but Undo can be refused (the target changed underneath it) or it can simply expire — the friction has to hold on its own before any of that is known, not retroactively once an undo path exists.

## Considered Options

- **Friction scales with reversibility** — once audited writes carry a bounded Undo, drop type-to-confirm for anything under that bound. Rejected: the rule would have to be renegotiated every time the audit log's undo window changes, and it answers the wrong question. A delete of 999 documents by an unreviewed filter is exactly as easy to get wrong as a delete of 1001; "can be undone in principle" is not the same thing as "was actually the action the user meant to trigger this time."

## Consequences

- `ConnectionDeleteDialog` gains a type-the-name step, matching `DropCollectionConfirm`'s existing pattern rather than a new component.
- Aggregation stage delete stays instant but adds a single-level Undo toast: only the most recently removed stage is recoverable, and a second delete replaces the first toast's target rather than stacking a second one.
- Delete-all-matching was already type-to-confirm; this ADR keeps it there and gives the reason a name — it destroys server data by filter, the harder tier by definition, independent of how many documents that turns out to be.
- The "can/cannot be undone" copy the audit log adds to confirm dialogs (its own design work) states fact, it does not change which tier a dialog is on.
- A future destructive surface is placed by asking one question first — does this destroy server data by filter/container, or irreversibly destroy local persisted data? — not by asking whether an undo mechanism happens to exist for it yet.
