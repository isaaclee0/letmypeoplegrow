# Location Search Provider Failover Design

## Goal

Keep Settings location search responsive when Open-Meteo's geocoding host is unavailable by failing over to a configured Geoapify account. Preserve Open-Meteo's useful population metadata, avoid public demo services, and keep the selected church location and timezone contract unchanged.

## Observed Failure

The production server container can resolve and reach general HTTPS endpoints and Open-Meteo's forecast API, but TCP connections to `geocoding-api.open-meteo.com` time out. IPv6 is unavailable in the container and the resolved IPv4 endpoint also times out. The failure occurs before TLS or HTTP, so changing the search query or parsing cannot correct it.

The current request timeout does not reliably bound this connection phase. A failed lookup therefore waits on Node's connection attempt and then returns the existing generic `502` response.

## Provider Strategy

Open-Meteo remains the primary provider. It supplies place names, administrative region, country, coordinates, timezone, and population. A successful Open-Meteo response, including a valid empty result set, is authoritative and does not trigger fallback.

Geoapify is the managed fallback and is called only when the primary request fails because of a network error, timeout, non-success HTTP response, or malformed response. It is authenticated with `GEOAPIFY_API_KEY` from the server environment. The key is never returned to the client, included in logs, or stored in church data.

The application does not use Photon or another public demo endpoint. If Geoapify is not configured and Open-Meteo fails, the route returns the existing friendly unavailable response.

## Server Design

A focused location-search service owns provider requests, response validation, normalization, caching, and primary-provider health state. The Settings route continues to enforce the existing admin role and delegates searches to this service.

Both providers return a shared internal result shape:

- `name`
- `admin1`
- `country`
- `countryCode`
- `lat`
- `lng`
- optional `timezone`
- optional `population`
- `source`

Only valid results with a non-empty name and finite, in-range coordinates are returned. Provider-specific fields are mapped inside their adapters rather than leaking into the route or client.

The Open-Meteo request has a three-second whole-request deadline that covers DNS, connection, TLS, and response reading. Geoapify has the same deadline. Requests use a descriptive application user agent where the provider accepts one.

After an Open-Meteo failure, an in-process five-minute cooldown marks the primary unavailable. Searches during the cooldown go directly to Geoapify rather than repeatedly waiting three seconds. A successful Open-Meteo request clears the failure state. The cooldown is deliberately process-local and ephemeral; no database or cross-instance coordination is needed for a best-effort external search.

Successful results are cached in process by normalized query for ten minutes. The cache holds at most 250 queries and evicts the oldest entry when full, preventing unbounded memory growth. Concurrent identical searches share one in-flight operation so a burst of debounced requests does not duplicate provider calls.

## API and Client Behaviour

The existing `GET /api/settings/location-search?q=...` contract remains additive. Its response still contains `results`; each result may now also contain `population` and `source`.

The Settings dropdown continues to show the existing display name. When population is present, it shows a compact formatted population beneath the location context to help distinguish similarly named places. Results without population remain visually complete and do not show an empty placeholder.

Provider attribution is shown below the results. Open-Meteo results show a linked `Open-Meteo` label. Geoapify results show linked `Powered by Geoapify` and `© OpenStreetMap contributors` labels. The source is presentation metadata only and is not saved with the church.

Selecting a result continues to send only the display name and coordinates to the location update endpoint. The server derives the authoritative IANA timezone locally with `tz-lookup` and atomically saves it with the location, so fallback results do not need to provide a timezone.

## Error Handling and Logging

Provider failures are logged with provider name, elapsed time, failure category, HTTP status when available, and whether fallback was attempted. Logs exclude the Geoapify API key and full request URL. Search text may be omitted from error logs because it is unnecessary for diagnosing network health.

When Open-Meteo fails and Geoapify succeeds, the user receives results normally. When both providers fail, or when Open-Meteo fails and Geoapify is not configured, the route returns `502` with `Location search is temporarily unavailable.` No low-level provider or network detail is exposed to the browser.

Client request supersession remains unchanged: late results from an older debounced query cannot replace results for newer input.

## Configuration

`GEOAPIFY_API_KEY` is documented in `server/.env.example` as an optional location-search fallback credential. Production startup does not fail when it is absent because the primary provider can operate independently. Startup and request logs report only whether the fallback is configured, never its value.

## Testing Strategy

Server tests cover:

- Open-Meteo success without calling Geoapify.
- Open-Meteo population and timezone normalization.
- A valid empty Open-Meteo result without fallback.
- Primary timeout, network error, non-success response, and malformed response falling back to Geoapify.
- Geoapify normalization and invalid-result filtering.
- The primary cooldown skipping Open-Meteo after a failure and expiring correctly with an injected clock.
- Query caching, bounded eviction, and identical in-flight request sharing.
- Missing Geoapify configuration and total provider failure returning the existing `502` contract.
- Logs and errors never containing the configured API key.

Client tests cover optional population rendering, provider attribution, results without population, and the existing stale-request protection.

Verification uses the focused server location tests, focused Settings location tests, and the client type/build check. A manual container check confirms both configured provider endpoints can be reached from the deployed server network.

## Non-Goals

- Bundling or maintaining an offline place database.
- Using a public demo geocoder.
- Combining or re-ranking results from both providers during normal operation.
- Falling back merely because Open-Meteo returns no matches.
- Changing location persistence, church isolation, or timezone derivation.
- Adding address-level search or map selection.
