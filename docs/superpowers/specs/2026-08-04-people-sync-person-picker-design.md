# People Sync Person Picker Simplification

## Goal

Make choosing an LMPG person from a sync review quick and predictable. Searching for a first name must return only people whose own names match, rather than everyone related to a matching family member.

## Scope

Apply the same interaction to both people-sync selection dialogs:

- the normal match picker (`PeoplePickerDialog`)
- the established-link correction picker (`EstablishedLinkDialog`)

No server contract, review decision, eligibility, or link-correction behavior changes.

## Search behavior

Normalize the query and each person's own first name, last name, and combined full name for case-insensitive matching. Family names and other family members must not contribute to search matching.

An empty query continues to show the available candidate list. Existing candidate ordering and exclusions remain unchanged.

## Result design

Render each result as one compact, full-width selection row:

- the person's full name is the primary label
- their family name is smaller, muted supporting text
- missing, unavailable, or unnamed family data uses the existing concise fallback wording
- eligible rows select immediately when clicked or tapped
- there is no separate “Use this person” or “Select …” control below the result

The row remains an accessible button named for the selection action. Ineligible people remain disabled and keep their existing explanation so reviewers cannot bypass matching safeguards.

Do not show expandable family-member previews in picker results. Those details caused visual weight and made the interaction appear family-oriented rather than person-oriented.

## Testing

Focused component tests will cover both dialogs:

- a first-name query matches only people with that first name, not relatives of somebody with that name
- family names do not act as search terms
- family name is rendered as secondary context
- clicking the compact person row selects or relinks that individual
- no separate nested selection control or expandable family-member details are rendered
- disabled candidates remain disabled with their reason visible

Run the two dialog test files and the affected sync-review integration tests after implementation.
