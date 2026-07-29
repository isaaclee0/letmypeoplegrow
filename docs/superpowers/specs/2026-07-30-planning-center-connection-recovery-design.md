# Planning Center Connection Recovery Design

**Date:** 2026-07-30  
**Status:** Proposed

## Problem

Planning Center access tokens are intentionally short lived. LMPG refreshes
them before normal source reads, but a refresh token can be revoked or become
invalid. When that happens, the church needs a safe way to restore its
connection without deleting its batches, List selections, links, or people
authority configuration.

The existing Disconnect action is deliberately blocked while Planning Center
is the authoritative people provider. That is correct for a destructive
disconnect, but it is not a recovery path for a broken credential.

## Decision

Add a non-destructive **Reconnect Planning Center** action alongside the
existing Disconnect action.

- Reconnect starts the normal OAuth authorization flow and, on success,
  replaces the church-scoped credential through the existing connection store.
- It preserves source batches, active/draft List selections, PCO links,
  authority-provider settings, and schedules.
- It is available to an administrator even while Planning Center is the
  authority provider.
- Disconnect remains destructive and remains blocked while Planning Center is
  authoritative. It deletes the connection credentials only after the church
  has completed a reviewed authority change away from Planning Center.

## Token Lifecycle

1. Continue proactively refreshing an access token through the existing
   church-scoped, single-flight refresh manager before source reads, scheduled
   reconciliation, and relevant PCO operations.
2. If a PCO request unexpectedly returns `401`, force one credential refresh
   and retry that request once. Do not retry repeatedly.
3. If the forced refresh or retry fails, classify the result as
   `SYNC_SOURCE_AUTH`: source health becomes `error`, scheduled sync skips the
   batch without roster mutation, and normal missing-source notifications are
   not sent.
4. Show an actionable authentication-recovery message in the Planning Center
   integration panel and expose Reconnect there. The existing safe error code
   may remain visible for diagnostics.
5. A successful reconnect clears the connection-level authentication error on
   the next successful source read; it does not auto-apply a source draft or
   change any batch membership.

## UI

- Connected, healthy: show existing connection details and Disconnect.
- Connected but PCO authentication failed: show **Reconnect Planning Center**
  as the primary recovery action and explain that it replaces credentials while
  retaining Lists, batches, and linked people.
- Disconnected: show Connect Planning Center.
- Disconnect confirmation continues to say that tokens will be removed. When
  PCO is authoritative, retain the current instruction to complete the
  reviewed authority change first.

## Safety and Tests

- OAuth callback must replace credentials atomically through the existing
  church-scoped connection store; never retain a stale fallback token after a
  successful reconnect.
- Test forced refresh then one retry on a `401`, refresh failure, retry failure,
  and no repeated retry loop.
- Test that auth failure records `error`, creates no missing-source
  notification, and does not cause archive/presence mutation.
- Test that Reconnect is shown for authentication failure regardless of PCO
  authority, while Disconnect remains guarded.
- Test reconnect initiation preserves the existing safe app-relative return
  target and successful callback preserves batch configuration.

## Non-goals

- Revoking the church's grant at Planning Center from LMPG.
- Automatically reconnecting without an administrator completing OAuth.
- Removing or changing Planning Center List membership or refresh behaviour.
- Changing authority provider as part of reconnect.
