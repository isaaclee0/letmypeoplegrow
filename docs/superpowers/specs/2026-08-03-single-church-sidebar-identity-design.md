# Single-church sidebar identity design

## Goal

Make the current church name feel like an intentional identity element when a user has access to only one church. It should have more visual hierarchy than the existing plain extra-small text without competing with the active navigation item.

## Scope

Change only the non-interactive, single-church branch of `ChurchSwitcher`. The existing multi-church dropdown, switching behavior, navigation, and authentication behavior remain unchanged.

Apply the treatment wherever the single-church branch appears, including the desktop sidebar and mobile drawer.

## Visual treatment

Render the church name inside a compact identity card with:

- a small contextual label identifying the value as the current church;
- a larger, medium-weight church name;
- a faint translucent background and border that work on the existing coloured and dark sidebar surfaces;
- a narrow secondary-colour accent bar;
- rounded corners and restrained spacing consistent with the sidebar;
- normal text wrapping so long church names remain readable without overflowing.

The card remains static content. It must not use button styling, hover effects, or any other affordance suggesting that it is interactive.

## Component contract

`ChurchSwitcher` continues to accept its existing `className` and `textClassName` props. In the single-church branch, `className` controls the outer card placement and `textClassName` remains available for caller-supplied text colour adjustments. The component supplies the new default hierarchy and card presentation.

The multi-church branch retains the existing dropdown markup and styling.

## Accessibility

The contextual label and church name are ordinary readable text with sufficient contrast on the sidebar. The single-church state exposes no button or click target. Long names wrap rather than being truncated.

## Testing

Extend the existing `ChurchSwitcher` component tests to verify that, when no other linked churches exist:

- the current church is presented in a labelled identity region;
- the name uses the new larger text treatment;
- no button is rendered.

Retain the existing dropdown and switch-action tests to guard the multi-church behavior.
