# Provider-Owned Sync Source Cutover

## Purpose

This runbook covers the coordinated replacement of the one production
version-1 Planning Center sync batch with a provider-owned Planning Center
List. It intentionally has no compatibility mode: the selected List becomes
eligible only after **Review & sync** has promoted it.

## Preconditions

- Schedule a cutover window with the church administrator.
- Ensure an LMPG administrator can access the connected Planning Center
  account and the batch.
- Keep unattended Planning Center sync disabled for this church until the
  successful review has been applied and checked.

## Coordinated sequence

1. Identify the one production church and its one current v1 Planning Center
   batch.
2. With the church administrator, create or confirm the equivalent Planning
   Center List and refresh it inside Planning Center.
3. Record the current LMPG batch settings, linked-person count, gathering
   target, schedule, and a roster snapshot for rollback comparison.
4. Deploy the source-based release with unattended sync disabled for that
   church during the cutover window.
5. Select the List in the existing batch, save the source draft, run
   **Review & sync**, inspect adds, links, restores, archives, and gathering
   changes, then apply.
6. Confirm the batch shows the correct active List, source status
   `available`, provider refresh time, and LMPG read time.
7. Re-enable unattended sync, invoke one controlled scheduled run, and confirm
   the audit and source provenance.
8. Exercise a non-destructive missing-source test in staging or with an
   injected provider fixture: the scheduled run must skip mutation and create
   one administrator notification.
9. Confirm Elvanto Category and Group creation and review flows in staging.
10. Keep the old filter columns and table data untouched for forensic rollback,
    but do not restore old runtime code.

## Abort criteria

Abort before applying the review, keep unattended sync disabled, and retain the
recorded comparison snapshot if any of the following occurs:

- the selected source cannot be resolved;
- complete pagination fails;
- the review differs materially from the List agreed with the church;
- unexpected archives or removals appear; or
- source promotion does not commit atomically with reconciliation mutations.

Do not substitute the old local filter runtime. Resolve the provider source or
revert the deployment through the normal release process, using the preserved
legacy data only for diagnosis and comparison.

## Completion record

Record the church, batch ID, Planning Center List ID and name, operator,
cutover time, review summary, controlled-run ID, and the result of the
missing-source test. Leave unattended sync enabled only after all completion
checks have passed.
