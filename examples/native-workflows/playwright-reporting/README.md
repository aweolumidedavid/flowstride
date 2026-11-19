# Share a JavaScript helper with Playwright

Both the [Playwright spec](specs/discounts.spec.cjs) and the [Flowstride scenario](flows/discounts.flow) call [the same JavaScript function](helpers/catalog.js). The helper calculates the discounted total in cents and returns a number.

Copy this folder into a CommonJS test project with an installed Flowstride build that includes the reporter. Run these commands from the copied folder. Flowstride needs Chromium for local runs, so install it with `npx playwright install chromium` if it is missing.

```sh
npx playwright test
npx flowstride run flows/discounts.flow --ci
npx flowstride report
```

Saved runs shows one result from each runner. Both tests verify a total of 22,500 cents after the 10% discount. The example needs no test server or Cloud account.

To connect an existing suite, keep its current imports and configuration and add the reporter from [the Playwright reporting guide](../../../NATIVE_CI.md#report-existing-playwright-test-suites).
