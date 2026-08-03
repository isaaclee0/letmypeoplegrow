# New Sync Batch Review Navigation

## Goal

After an administrator creates a Planning Center or Elvanto sync batch, open that batch's existing Review & sync page immediately instead of returning to the integration panel and requiring another click.

## Behavior

- A successfully created Planning Center batch navigates to `/app/settings/integrations/planning-center/batches/:id/review`.
- A successfully created Elvanto batch navigates to `/app/settings/integrations/elvanto/batches/:id/review`.
- Saving an existing batch keeps the current behavior: close the editor and refresh the integration data without navigating.
- Validation and API errors remain in the batch editor and do not navigate.

## Implementation

Each integration panel already owns routing and receives the saved batch from its editor. The panel will distinguish creation from editing in its `onSaved` callback. For a new batch, it will use the returned batch ID to navigate directly to the existing provider-specific review route. For an edited batch, it will retain the existing reload behavior.

This keeps route knowledge out of the reusable editor components and avoids an extra list reload before review.

## Verification

Panel-level tests will cover both providers by creating a batch and asserting navigation to the returned batch ID's review route. Existing edit-path coverage will continue to verify that edit mutations remain available without redirecting to review.
