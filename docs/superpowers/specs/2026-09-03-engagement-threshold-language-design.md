# Engagement Threshold Language Design

## Goal

Make engagement tier settings understandable in everyday attendance language while retaining configurable percentage thresholds as the exact calculation rule.

## Settings presentation

- Keep `coreMinimum` and `casualMinimum` as whole-number percentage inputs. No API, database, or calculation behavior changes.
- Give each input a visible `%` suffix and describe it as a share of eligible gathering opportunities.
- Pair the inputs with plain-language monthly guidance:
  - Core: typically attends 3+ times a month.
  - Casual: typically attends 1–2 times a month.
  - Irregular: typically attends once a month or less.
- State that the monthly descriptions assume a roughly weekly primary gathering; percentages remain authoritative for churches with other schedules.
- Replace the current technical weekly/fortnightly/monthly example box with a concise live summary of the configured percentage ranges.
- Continue allowing tier names and colours to be customized.

## Validation and accessibility

- Retain the existing whole-number, 0–100 validation and requirement that the casual minimum is below the core minimum.
- Associate helper text and the percent suffix with each numeric input.
- Preserve keyboard operation, visible labels, focus treatment, and suitable light/dark contrast.

## Testing

- Verify both percentage fields retain their values and save the unchanged API shape.
- Verify the monthly guidance, percent suffixes, exact range summary, and schedule qualification are visible.
- Verify invalid threshold relationships still produce the existing validation error.

## Out of scope

- Changing tier calculations, defaults, persistence, historical reconstruction, or report classifications.
- Automatically deriving thresholds from a church's gathering schedule.
