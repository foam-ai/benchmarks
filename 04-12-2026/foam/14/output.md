[Foam Trace ID: 2bed172ce79051187607bb7453505585] ## TL;DR

The `/issues/[issueId]` Next.js Server Component crashes at runtime when an unauthenticated (or expired-session) user visits the page. `getUser()` legitimately returns `{ user: null, ... }` for unauthenticated sessions, but the page immediately dereferences `user!.customerId` using TypeScript's non-null assertion operator — which provides zero runtime protection — throwing `TypeError: Cannot read properties of null (reading 'customerId')`. The fix is to add an auth guard (`if (!user) redirect('/login')`) before the property access.

## What Broke and Why

### 1. Auth helper returns `null` user for unauthenticated sessions (by design)

`getUser()` in `/repo/porygon/actions/auth.ts` calls `GET ${BACKEND_URL}/auth/status` with the request cookies. When the session is absent or expired, the backend returns HTTP 200 with `{ isLoggedIn: false, user: null/undefined, customer: null/undefined }`. The function never throws and never redirects — it always returns a typed `AuthStatus` object:

```typescript
// getUser() — all unauthenticated paths return null user
if (!response.ok) {
  return { isLoggedIn: false, user: null, customer: null, installationComplete: false };
}
// ...or when backend returns isLoggedIn: false:
return { isLoggedIn, user, customer, installationComplete };
// ↑ user is null/undefined here
```

This is confirmed by the telemetry: the HTTP POST Server Action response captured in session `171e83cd065d22a9cbabe9ff0f6eef4d` shows:
```json
{"isLoggedIn":false,"user":"$undefined","customer":"$undefined","installationComplete":false}
```
The same null-auth pattern fired **twice in the same session** (for issue IDs `1b1affd5-...` and `9972d813-...`), confirming it is consistent and reproducible.

### 2. The page uses a non-null assertion with no runtime guard

`/repo/porygon/app/(platform)/issues/[issueId]/page.tsx` destructures `user` from `getUser()` and immediately dereferences it with the TypeScript non-null assertion operator `!`:

```typescript
async function IssuePage({ params }: Props) {
  const { user } = await getUser();       // user is null when unauthenticated
  const { issueId } = await params;
  const { issue, status } = await getData(issueId, user!.customerId);  // ← CRASH
  //                                                 ^^^^
  // TypeScript's ! only suppresses the compile-time type error.
  // At runtime, null!.customerId throws:
  // TypeError: Cannot read properties of null (reading 'customerId')
```

There is no `if (!user)` check, no optional chaining (`user?.customerId`), and no early redirect before this line. The `redirect('/login')` that does exist in the component fires on a 401 from the *data* API — well after the crash site — and would never trigger anyway because the auth backend returns HTTP 200 (not 401) for unauthenticated sessions.

### 3. No auth guard in the layout either

`/repo/porygon/app/(platform)/layout.tsx` contains only UI shell elements (`<MiniHeader />`, `<Footer />`) — it performs no `isLoggedIn` check and no redirect. Authentication is entirely the responsibility of individual page components. Other pages in the codebase (e.g., `/login/page.tsx`, `/signup/create/page.tsx`) correctly check `if (isLoggedIn) redirect(...)` before using the user object. The issues page skips this pattern entirely.

### 4. Next.js catches the RSC crash and strips the message in production

The `TypeError` thrown in the Server Component is caught by Next.js, which sanitizes the real message in production builds and replaces it with the generic:
> *"An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance…"*

This sanitized error is what the browser RUM SDK (`porygon-browser`) captures, explaining why the telemetry contains no stack trace and no real message — the actual `TypeError: Cannot read properties of null (reading 'customerId')` only exists in server-side logs (absent from this trace).

### Full causal chain

```
Unauthenticated/expired session user navigates to /issues/[id]
  → getUser() calls /auth/status → backend returns HTTP 200 { isLoggedIn: false, user: null }
  → IssuePage receives { user: null }
  → user!.customerId evaluated at runtime → TypeError: Cannot read properties of null (reading 'customerId')
  → Next.js RSC error handler catches throw → sanitizes message for production
  → Browser RUM SDK records generic "Server Components render error" span
```

## Fix

Add an authentication guard in `IssuePage` **before** any property access on `user`:

```typescript
async function IssuePage({ params }: Props) {
  const { user, isLoggedIn } = await getUser();

  // Guard: redirect unauthenticated users before touching user properties
  if (!isLoggedIn || !user) {
    return redirect('/login');
  }

  const { issueId } = await params;
  const { issue, status } = await getData(issueId, user.customerId); // now safe
  // ...
}
```

**Why this breaks the causal chain:** The `redirect('/login')` fires before `user.customerId` is ever evaluated, so the `TypeError` cannot be thrown. The Server Component render completes (via redirect) without error. This matches the pattern already used correctly in other pages in the same codebase.

Note: The non-null assertion `user!` should also be removed — it was masking the type-level signal that `user` could be `null`. With the explicit guard above, the subsequent `user.customerId` access is both type-safe and runtime-safe without needing `!`.


---
