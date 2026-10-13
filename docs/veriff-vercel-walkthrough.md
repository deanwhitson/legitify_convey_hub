# Hosted Veriff walkthrough

Latest invitation walkthrough (13 October 2026):
https://legitify-convey-9al21a7uu-dean-whitsons-projects.vercel.app.
See `docs/veriff-email-invitations.md` for the confirmation/email-first flow
and remaining real-delivery dependencies. The original deployment below is
retained as historical evidence.

Published 13 October 2026 at 12:16 SAST to the existing Vercel project
`legitify-convey-hub` as a **Preview** deployment.

URL: https://legitify-convey-1at4p8kog-dean-whitsons-projects.vercel.app

Deployment ID: `dpl_GkEo1UZ69DtmzPLQ42zofjZrye9z`.
The Vercel inspection command confirmed status **Ready**, target **preview**.
The site's root redirects to `/idv-harness.html?provider=veriff`.
Vercel's existing preview protection requires the project owner's Vercel login.

This is the local synthetic walkthrough hosted remotely, requested after the
local demo review. It is not the connected saved-party production application.
Use Verify identity → Start verification, then the labelled simulated outcome
buttons and Refresh status. The synthetic capture link has been removed from
the demo so users cannot navigate to a non-working provider session.

The four static harness files were packaged with Vercel's Build Output API.
No API functions, real party data, passport capture, Veriff credentials or
Neon connection strings are included. The packaging scan checks the output
against private configuration values without displaying them. No database,
production alias or project access/protection setting was changed.

Validation: harness build, four capture tests and frontend TypeScript check
passed. The hosted URL reached the expected Vercel authentication screen;
an authenticated hosted walkthrough could not be exercised in this browser
because it is not signed in. The local walkthrough was previously verified
for capture preview, simulated outcomes and separate-party state.

Rebuild/package commands (workspace root for the second command):

```text
node node_modules/vite/bin/vite.js build --config vite.config.idv.ts
python output/veriff-poc/package_vercel_demo.py
```

Deploy from workspace `output/veriff-vercel-demo` with
`vercel deploy --prebuilt --yes --scope team_AB913MRopZiwUOFDCbniRwfn`.
Do not use `--prod` for this isolated walkthrough.
