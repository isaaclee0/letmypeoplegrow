# Weekly Review AI Insight — Name Obfuscation

## Problem

`server/services/weeklyReviewInsight.js` generates the AI-written insight included in
the weekly review email. It runs automatically for every church using the
**platform's own** Anthropic/xAI API keys (`PLATFORM_ANTHROPIC_API_KEY` /
`PLATFORM_XAI_API_KEY`) — not a key the church supplied — and is on by default
(`weekly_review_email_include_insight INTEGER DEFAULT 1` in `server/config/schema.js`).

`buildContext()` sends real first/last names, family surnames, and per-person
attendance patterns to the AI provider. The system prompt explicitly says *"Use the
real names provided — they will appear in an email to church leaders."* The Settings
toggle for this feature is just labeled "Include AI insight," with no disclosure that
real member names leave the system to reach a third-party AI provider by default.

This is distinct from `/api/ai/ask` (`server/routes/ai.js`), where a church admin
explicitly connects their own AI provider key — that path is out of scope here (see
"Out of scope" below); it will get a UI disclosure instead of obfuscation.

## Goals

- Stop sending real member/family names to the AI provider for the weekly review
  insight, without losing the natural, pastoral prose that's the point of the feature.
- Make the AI's use of placeholder tokens reliable enough that real names can always
  be restored before the insight is emailed or stored.
- Fail safe: if token round-tripping ever breaks, never show a token or a wrong name
  to the church — fall back to the existing algorithmic insight instead.
- Disclose the behavior in Settings copy.

## Non-goals

- Obfuscating the `/api/ai/ask` chat endpoint (church-configured AI key). That
  surface will instead get a UI warning that real names are required for it to work.
  Not part of this change.
- Scrubbing names out of admin-authored free text (the weekly-guidance wizard and its
  distiller in `weeklyReviewGuidance.js`). That text is voluntarily typed by an admin,
  not pulled from the database automatically, and reliably detecting names inside free
  text would require NER. If an admin types a real member's name into their own
  guidance notes, it reaches the AI verbatim — unchanged from today.
- Obfuscating church or gathering names. Not personal data, and needed verbatim for
  the insight to be useful.
- Any schema or database change. Token maps are built fresh in memory on every
  `generateInsight()` call and discarded afterward — nothing is persisted.

## Architecture

All changes are contained in `server/services/weeklyReviewInsight.js`. Four existing
`reviewData` structures carry names, and — confirmed by reading
`server/services/weeklyReview.js` — every entry in all four already carries a real
database ID, not just a display name:

| Structure | Name fields | ID fields |
|---|---|---|
| `engagementChanges` (both individual and `isFamily` entries) | `firstName`/`lastName` or `familyName` | `personId`, `familyId` |
| `crossGatheringShifts` | `firstName`, `lastName`, `familyName` | `personId`, `familyId` |
| `familyPatterns` | `familyName` | `familyId` |
| `visitorRetention.current.integrationCandidates` (raw DB rows, snake_case) | `first_name`, `last_name` | `id` |

Because real IDs are available everywhere, tokens are keyed by ID, not by name string —
this rules out any name-collision edge case (e.g. two members who happen to share a
name).

### 1. Token maps

```
buildTokenMaps(reviewData) -> {
  personTokens: Map<personId, token>,   // token = "Person1", "Person2", ...
  familyTokens: Map<familyId, token>,   // token = "Family1", "Family2", ...
  reverseMap: Map<token, realDisplayName>,
}
```

Walks the four structures above in order, assigning each unique `personId`/`id` and
`familyId` the next token the first time it's seen. `reverseMap` stores what each
token expands back to (`"Person1" -> "Jordan Smith"`, `"Family2" -> "the Ashworth
family"` — used only for text substitution, never persisted).

### 2. Tokenize before building context

```
tokenizeReviewData(reviewData, maps) -> tokenizedReviewData
```

A deep clone of the same four structures with name fields replaced by their token
(handling the `integrationCandidates` snake_case shape as a special case) and
`familyName` fields replaced by the matching family token, so an individual's
"(Family2 family)" annotation stays consistent with a separate "Family2 family: ..."
line elsewhere.

`buildContext()` itself is **not modified** — it already just interpolates whatever
`firstName`/`lastName`/`familyName` values it's given, so feeding it
`tokenizedReviewData` is sufficient. (A resulting double space from an empty
`lastName` field is a harmless artifact of text sent to the model — it's never shown
to a human, since only the rehydrated response reaches the email/UI.)

### 3. System prompt changes

`BASE_SYSTEM_PROMPT` gains explicit tokenization instructions, since the whole scheme
depends on the model understanding and complying with it:

- The data below uses placeholder tokens (`PersonN` for individuals, `FamilyN` for
  families) instead of real names.
- Always refer to that person/family using the **exact** token given.
- Never invent a real-sounding name for anyone.
- Never alter a token's spelling, spacing, or case.
- Treat each token exactly as you would a proper name in a sentence (subject,
  possessive, etc.).

The existing "Use the real names provided" sentence is removed/replaced accordingly.
`composeSystemPrompt(guidance)` is otherwise unchanged — church-provided guidance text
is still appended as delimited background, untouched by tokenization (see Non-goals).

### 4. Rehydration + fail-safe fallback

After `callClaude`/`callGrok` returns:

```
rehydrate(text, reverseMap) -> string
```

For each token, replace `\btoken\b` (word-boundary regex, so `Person1` cannot match
inside `Person10`) with its real display name from `reverseMap`. Order-independent.

Then scan the rehydrated text for any leftover `\bPerson\d+\b` or `\bFamily\d+\b`. If
one is found — the model invented a token it wasn't given, or a round-trip otherwise
broke — discard the AI response entirely, log a warning, and call
`generateAlgorithmicInsight(reviewData)` instead, exactly like the existing
try/catch-driven fallback paths in `generateInsight`. This failure mode is cosmetic
(a broken or unavailable sentence), never a privacy leak: the model was never given a
real name it could leak.

`saveInsightAsConversation` is unchanged — it always receives the final,
already-rehydrated (real-name) text, same as today.

### 5. Settings disclosure copy

`client/src/pages/SettingsPage.tsx` (~line 1093), the "Include AI insight" toggle,
gets an added helper line under the existing label:

> "Member names are replaced with placeholders before this request reaches the AI
> provider, and restored only in what you see here."

This is the working copy for implementation; minor wording polish during review is
fine, but the content — that names are placeholder-substituted outbound and restored
only for on-screen/email display — must be preserved.

## Testing

Extend `server/services/weeklyReviewInsight.test.js`:

- `buildTokenMaps` assigns one stable token per unique `personId`/`familyId`, reused
  correctly when the same ID appears in more than one of the four structures.
- `tokenizeReviewData` output (as fed through the real `buildContext`) contains zero
  real names or family names — only tokens — for a fixture `reviewData` populated
  across all four shapes, including the snake_case `integrationCandidates` rows.
- `rehydrate` correctly restores real names, including possessive forms
  (`"Person1's"` → `"Jordan Smith's"`) and adjacent-token edge cases
  (`Person1` vs `Person10`).
- Fallback path: when the (mocked) AI response contains a token not present in the
  map, `generateInsight` returns the algorithmic insight instead of the AI text.
- `composeSystemPrompt` includes the new tokenization instructions and still appends
  church guidance unchanged.

No manual/integration verification of the outbound HTTPS payload is planned — logging
real request bodies to check this by hand would itself mean dumping member PII to
logs. Unit tests over the pure tokenize/rehydrate functions are the verification
surface.

## Out of scope

- `/api/ai/ask` (church-configured AI key): gets a UI disclosure instead, not
  obfuscation. Separate, smaller follow-up.
- Admin-authored weekly-review guidance text and its distiller: unaffected, per
  Non-goals above.
- Church/gathering names: unaffected, not personal data.
