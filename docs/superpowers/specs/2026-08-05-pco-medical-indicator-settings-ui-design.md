# PCO Medical Indicator Settings UI Design

## Goal

Make the Planning Center medical-indicator settings compact and consistent with the individual badge editor on the People page, without changing persistence or sync behaviour.

## Collapsible panel

- The panel starts collapsed each time the Planning Center integration page is opened.
- Its always-visible header contains the title, privacy summary, enable switch, and expand/collapse control.
- The enable checkbox becomes the same switch style used by other integration settings.
- Turning the switch on updates the unsaved form state and automatically expands the panel.
- The user may collapse or expand the panel while it is enabled.
- Changing the switch does not save immediately; the existing Save action remains authoritative.

## Appearance picker

- The expanded panel mirrors the individual badge editor's icon-tile grid and colour controls.
- The icon grid contains all supported badge icons.
- The individual editor's **Default** tile is replaced with **Adopt existing**.
- Selecting **Adopt existing** reveals the icon-only badge appearances currently assigned to active or archived people.
- Selecting an existing appearance copies its icon and colour into the medical-indicator form and marks the save as an adoption.
- Saving an adoption retains the existing destructive-cleanup confirmation, including the number of affected people.
- Selecting a normal icon tile or changing either colour control exits adoption mode.
- Colour selection uses the same native colour swatch and editable hexadecimal input as the individual badge editor.
- The current medical-indicator preview remains visible when both an icon and valid colour are selected.

## Unchanged behaviour

- Minimum access level, gathering scope, validation, Save, Refresh, and failure messages remain unchanged.
- The UI continues to submit the existing settings payload and `adoptExistingAppearance` flag; no server or database changes are required.
- Medical-note text is never requested or stored.

## Adoption confirmation

- The existing destructive confirmation keeps its title, warning copy, and save behaviour.
- Its action row matches other destructive confirmation modals in the Planning Center UI.
- Cancel and Confirm are equal-width buttons.
- Cancel uses the standard bordered light/dark secondary-button styling.
- Confirm uses the standard red destructive-button styling, including hover, focus, and disabled states.
- Both actions are disabled while saving, and the destructive action reads **Saving…** until the request completes.

## People badge placement

- People cards render ordinary and medical badges in one top-right badge group.
- The ordinary badge appears first and the medical badge second, separated by a small horizontal gap.
- A person with only one applicable badge retains the existing top-right badge position.
- The medical badge no longer appears beside the person's name on the People page.

## Badge filtering

- The People and Attendance badge filter controls include the configured medical badge whenever the server supplies an enabled and authorized medical-indicator appearance.
- The medical option uses the configured icon and colour and is labelled **Medical note recorded**.
- A person may contribute both an ordinary badge key and the medical badge key.
- Selecting badge filters retains the existing OR behaviour: a person is included when any selected badge key applies.
- The medical filter includes people whose scoped API record has `hasMedicalNotes: true`, including people who also have an ordinary badge.
- Existing server-side role and gathering visibility rules remain authoritative; the client does not infer medical-note presence.

## Tests

Component tests will verify that:

- the panel starts collapsed.
- the switch uses switch semantics and expands the panel when enabled.
- the enabled panel can be collapsed again.
- icon tiles and matching colour controls are rendered.
- **Adopt existing** reveals existing appearances.
- selecting and saving an existing appearance still requires destructive confirmation.
- the confirmation renders the standard secondary and destructive actions and prevents duplicate submission while saving.
- People cards group medical and ordinary badges in the top-right position.
- People and Attendance filters include and match the configured medical badge without excluding a person's ordinary badge.
