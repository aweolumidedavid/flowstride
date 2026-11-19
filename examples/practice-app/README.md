# Flowstride practice app

From a new Flowstride project, run these commands after installing the Flowstride package.

```sh
npx flowstride init
npx flowstride run
```

`init` checks for matching Chromium binaries and copies the starter flows, advanced flows, and their helpers. The default practice run opens the live Flowstride dashboard and runs `browse-catalog.flow` followed by `login.flow` from `flows/examples/starter`.

Each practice run starts the bundled app on an available `127.0.0.1` port. Relative browser and API URLs in the examples use that address. The app stays available during the dashboard session for replay and reruns. Close the dashboard or press Ctrl+C to end the local session.

Open **Logs**, then choose **Watch browse-catalog.flow** or **Watch login.flow** when a recording is ready. In an existing practice project from an earlier build, set `"recordVideo": true` in `flowstride.config.json` to enable recording for the starter.


Use `npx flowstride run --ci` to run once headlessly and stop the app at the end. `npx flowstride report` opens saved CI results. Once the package and browser are installed, the examples run offline.

In a project that already has Flowstride tests or configuration, use a separate practice workspace.

```sh
npx flowstride init --practice
cd .flowstride/practice
npx flowstride run
```

Run an individual example by passing its path to `npx flowstride run`. Rerunning `init` preserves edits to the examples and configuration. If you add your own tests to a practice workspace, run them by their own path so they can use their own application URL.

## Advanced examples

```sh
npx flowstride run flows/examples/advanced
```

- `check-catalog-prices.flow` calls a TypeScript helper to match all 50 browser cards to API records by SKU. It checks the displayed prices, discount rules, and totals for pickup, local delivery, regional shipping, and freight.
- `admin-creates-user.flow` fills the **Create a user** form and creates a **Member**. In the same browser session, it selects **Booking approver**, clicks **Assign role**, and verifies the saved role on the user's row. The local app deliberately rejects the first role save. Flowstride removes that account and retries with a fresh one.
- `new-user-signs-in.flow` appears in the dashboard as **Waiting for admin-creates-user.flow** throughout the retry. When the admin flow passes, the user flow signs in with the approved account in a separate browser session and checks its identity and permission on the account page. Flowstride removes the test account after the sign-in flow.

Run just the handoff with `npx flowstride run flows/examples/advanced/new-user-signs-in.flow`. Flowstride automatically includes the admin flow. The demo uses one retry by default. Set `retries` to `0` in the practice project's configuration to see the user flow become **Blocked** when the admin fails. Add `--ci` for a headless run.

The bundled advanced examples show local browser frames and step screenshots with readable practice names and emails. Password fields show dots. Protected handoffs keep recordings, traces, and DOM snapshots disabled. Editing an advanced flow or helper keeps the standard handoff evidence protection in place.

The TypeScript helpers live in `helpers/practice` by default. The catalog example uses `practice/catalog.ts`. The account examples use `practice/user-fixtures.ts` to generate unique test details and register cleanup.

## API and browser in one test

```sh
npx flowstride run flows/examples/api-and-ui/approve-user-and-sign-in.flow
```

The scenario signs in to a cookie-aware API context as the admin, creates a Member, and assigns Booking approver. It checks each response and extracts the new account ID. The same scenario opens the practice app, signs in with the new account, and confirms the ID and **Can approve bookings** in the browser. Both parts use the local app.

## Practice data

The catalog has 50 seeded cars with fixed SKUs, prices, and discounts. The starter filters to Hatchback and checks that Kite 001 is priced at $10,800.00. The login example opens the account for the seeded driver.

| Test account | Email | Password |
| --- | --- | --- |
| Practice Driver | `driver@example.test` | `practice-driver` |
| Practice Admin | `admin@example.test` | `practice-admin` |

The administrator can create users and assign **Member** or **Booking approver**. A booking approver sees **Can approve bookings** in the account page. Accounts and sessions belong to that app instance. A new CLI session starts with fresh data.

Test helpers can read the catalog with `GET /api/cars` and use `POST /api/session` to start a session with the practice accounts. An administrator session can list and create users at `/api/admin/users`, assign a role with `PATCH /api/admin/users/:id/role`, and delete a test user with `DELETE /api/admin/users/:id`.
