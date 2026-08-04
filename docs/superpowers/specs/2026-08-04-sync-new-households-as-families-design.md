# Sync New Households as Families

## Goal

When a Planning Center or Elvanto sync batch imports new people who belong to the same provider household, create or reuse one LMPG family and assign those people to it. This behavior must remain church-scoped, provider-scoped, reviewable, deterministic, and atomic with the rest of the reviewed sync apply.

## Household reconciliation

Household reconciliation happens while building the provider-neutral people-sync plan. The orchestrator supplies the planner with the complete provider family projection, local families, and existing provider family links.

For each external household containing at least one person eligible for the batch:

1. Resolve its known members through durable person links and unambiguous matcher results.
2. If the resolved members identify exactly one non-null local family, emit one `linkFamilies` action from the external household to that local family. New people from that household will join it during apply.
3. If no member resolves to a local person, every imported member is represented by an `addPeople` action, and no family link already exists, emit one `addFamilies` action for the household.
4. If resolved members identify multiple local families, or any member is ambiguous or otherwise unresolved rather than new, do not create or link a family automatically. Surface a `familyConflicts` review item and leave dependent new people family-less unless a safe reviewed resolution already exists.

An existing valid external-family link takes precedence and is reused. All family lookups and links remain scoped by both `church_id` and provider.

## Family naming

New family names use the existing LMPG adults-first convention: `Lastname, Firstname and Firstname`. A one-person household is therefore named `Lastname, Firstname`. Children are used for naming only when the household has no adults. Provider household names remain available in review context but do not override this LMPG naming convention for a newly created family.

If the available member data cannot produce a non-empty reviewed family name, the planner does not emit `addFamilies`; it emits a conflict instead. Apply continues to reject any family creation action without a non-empty reviewed name.

## Apply behavior

The existing transaction order is retained:

1. Create or update family links.
2. Create reviewed families and their provider links.
3. Create new people.

Because each `addPeople.familyId` is the external household ID, person creation resolves the newly inserted `external_family_links` row and writes the shared local `family_id`. Family creation, family linking, person creation, and person linking succeed or roll back together.

## Review and safety

Family actions are included in the deterministic plan, review counts, review context, and signed plan digest. Apply does not infer or create a family that was absent from the reviewed plan.

Household-only context members participate in deciding whether an existing family match or conflict exists, but they are not imported unless independently eligible. Partial or contradictory household evidence fails closed.

## Tests

Focused tests will prove:

- multiple new PCO household members produce one `addFamilies` action and share the created local family;
- multiple new Elvanto family members follow the same provider-neutral behavior;
- a one-person household receives the `Lastname, Firstname` family name;
- an unambiguous existing member family produces `linkFamilies` and new members join that family;
- an existing provider family link is reused without duplicate family creation;
- mixed, ambiguous, or multi-family household evidence does not auto-create a family;
- family and people writes roll back together on apply failure.
