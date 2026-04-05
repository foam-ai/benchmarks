## TL;DR
The `/issues` and `/issues/:issueId` Server Component pages crash because they access `user!.customerId` without null-checking `user` first — when `getUser()` returns a null/undefined user (session expired, auth failure), the non-null assertion throws a TypeError that Next.js wraps as the generic "Server Components render" error.

## What Broke and Why

The failure chain is:

1. **`getUser()` returns `{ user: null }` or `{ user: undefined }`**: This happens when the backend auth endpoint (`/auth/status`) returns a non-200 response (session expired, cookie invalid) or when the response JSON doesn't include a `user` field. The `getUser()` function in `porygon/actions/auth.ts` explicitly returns `{ user: null }` on failure, and if the backend returns `{ isLoggedIn: false }` without a `user` key, destructuring yields `undefined`.

2. **Unsafe non-null assertion `user!.customerId`**: Both issue pages use `user!.customerId` immediately after calling `getUser()`, BEFORE checking auth status:

   - `porygon/app/(platform)/issues/page.tsx` (line 66): `await getData(user!.customerId, params)`
   - `porygon/app/(platform)/issues/[issueId]/page.tsx` (line 43): `await getData(issueId, user!.customerId)`

   When `user` is null/undefined, this throws:
   - `TypeError: Cannot read properties of null (reading 'customerId')` (on `/issues/:issueId`)
   - `TypeError: Cannot read properties of undefined (reading 'customerId')` (on `/issues`)

3. **Next.js production error masking**: In production builds, Next.js catches the unhandled TypeError during Server Component rendering and replaces it with the generic message: *"An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."* This is the PORYGON-M error.

4. **No middleware protection**: There is no Next.js middleware or server-side auth guard on the `(platform)` route group. Authentication is only checked client-side via the `authenticate` HOC, but the server components execute and crash before client-side checks can redirect.

**Corroborating Sentry evidence**:
- Searching porygon errors for "customerId" reveals multiple `TypeError: Cannot read properties of null/undefined (reading 'customerId')` events with culprits `/issues` and `/issues/:issueId`, matching the exact file paths (`issues/page.tsx IssuesPage` and `issues/[issueId]/page.tsx IssuePage`).
- PORYGON-M URL tag distribution shows 11 events from `https://sdk.foam.ai/issues` (listing page) and many from individual issue detail URLs, confirming both routes are affected.
- All PORYGON-M events have null user data (user.id, user.email all null), consistent with unauthenticated/expired sessions.

## Fix

**Immediate fix** — Add null-check for `user` before accessing `customerId` on both pages, redirecting unauthenticated users to login:

**`porygon/app/(platform)/issues/page.tsx`**:
```typescript
async function IssuesPage({ searchParams }: { ... }) {
  const { service, page, range } = await searchParams;
  const { user } = await getUser();

  // Add this check BEFORE accessing user.customerId
  if (!user) {
    return redirect('/login');
  }

  const params = { ... };
  const { issues, pagination, status } = await getData(user.customerId, params);
  const serviceOptions = await getServiceOptions(user.customerId);
  // ... rest of component
}
```

**`porygon/app/(platform)/issues/[issueId]/page.tsx`**:
```typescript
async function IssuePage({ params }: Props) {
  const { user } = await getUser();
  const { issueId } = await params;

  // Add this check BEFORE accessing user.customerId
  if (!user) {
    return redirect('/login');
  }

  const { issue, status } = await getData(issueId, user.customerId);
  // ... rest of component
}
```

This removes the unsafe `user!` non-null assertion and redirects to `/login` when authentication has failed, preventing the TypeError from crashing the server component render.

---
