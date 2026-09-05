# Report layout drag interactions

## Goal

Make report customisation feel like direct manipulation. Users should move and hide panels on the report canvas, while restoration of hidden panels stays available without occupying permanent space.

## Customisation controls

- Rename **Customise reports** to **Customise layout** everywhere.
- While customising, show concise instructions, **Save layout**, and **Cancel**.
- Show **Reveal hidden sections** only when at least one panel is hidden.
- Opening it displays an accessible modal containing only hidden panels. Each row has a **Restore** action. The modal closes automatically when the last hidden panel is restored.
- Remove the permanent panel checklist and its raise/lower controls.

## Panel controls

- In customisation mode, each visible panel has a hamburger grab handle on its left edge and a small circular × button at its top-right.
- The × hides the panel in the current draft. Saving persists it; cancelling restores the saved state.
- The grab handle accepts mouse, pen, and touch input. Arrow keys move the focused panel for keyboard users.

## Drag behaviour

- Starting a drag creates a compact translucent preview beneath the pointer or finger.
- The original panel becomes visually subdued while remaining as the current layout placeholder.
- Crossing another panel's midpoint updates an internal preview order. Other panels animate into their prospective positions.
- A highlighted insertion marker shows where the panel will land. It uses the dragged panel's one- or two-column span.
- Releasing commits the preview order to the current unsaved layout. Escape or pointer cancellation restores the pre-drag order.
- Dragging is initiated only from the handle, so touch scrolling elsewhere on a panel remains normal.

## Layout and persistence

- Existing hidden-panel and unavailable-panel rules remain authoritative.
- The full-width long-term heading and attendance-history expansion continue to follow their associated panels.
- Drag previews do not call the preferences API. The existing **Save layout** action remains the persistence boundary.

## Verification

- Component tests cover naming, hidden-section restoration, pointer preview/commit/cancel, keyboard movement, hide controls, full-width placeholders, and unavailable panels.
- Browser verification covers desktop drag visuals, modal restoration, cancellation, and the existing report layouts in light and dark themes where available.
