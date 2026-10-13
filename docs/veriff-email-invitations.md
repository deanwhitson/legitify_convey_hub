# Attorney confirmation and email-first invitations

Dean selected email-first delivery on 13 October 2026 and confirmed no email
service has been configured. Both email and international cell number are
captured; SMS is not implemented or implied.

Updated walkthrough URL:
https://legitify-convey-9al21a7uu-dean-whitsons-projects.vercel.app
Deployment `dpl_D87MG2DLSLVieAC8HyapKgJz3uYZ` was inspected as Ready/Preview
on 13 October 2026 at 12:38 SAST. This replaces the original walkthrough link.

The updated Vercel walkthrough follows:

1. Verify identity / select a natural-person representative.
2. Enter/review full passport name, email and international cell number.
3. Review the recipient and explicitly confirm that the details are correct.
4. Send verification invitation (demo).
5. See "Invitation simulated — no email sent".
6. View verification status, start the simulated session and use demo outcomes.

The same confirmation component is used by the real saved-party entry point.
The server invitation endpoint requires staff write authority and rechecks
institution/matter/person bindings. Submitted name/email/phone must match the
saved person; editing this confirmation form does not silently change a saved
matter. Golden Record subjects without an authoritative saved phone/contact
projection fail closed rather than relying on browser-provided details.

Real server route:
`POST /api/v1/transfers/{transfer}/parties/{party}/id-verification/invitation`.
The BFF forwards the verified JWT unchanged to the Python owner. Missing
SMTP configuration fails before any provider session is created. SMTP uses
port 465 with certificate/hostname-verified TLS and server-only credentials.
Configure `VERIFICATION_SMTP_HOST`, `VERIFICATION_SMTP_PORT=465`,
`VERIFICATION_EMAIL_FROM`, `VERIFICATION_SMTP_USERNAME` and
`VERIFICATION_SMTP_PASSWORD` after setting up a sending service and authorised
sender. No real email was sent or tested during this implementation.

The message sends the selected client's private Veriff capture URL directly
to their saved email, explaining that they must capture their own passport and
selfie. It does not include a passport number, phone number, attachment or
result. SMTP acceptance is described as acceptance for sending, not delivery
or verified identity. No public DEEDLY result or invitation endpoint is added.

The additive proposal `docs/proposals/veriff_invitations.sql` records a unique
invitation per verification attempt, recipient hash and sending/accepted/
uncertain state. It requires the original Veriff verification table proposal.
Neither proposal has been applied to Neon. Missing invitation storage prevents
provider session creation. A failed or interrupted send stays uncertain and
cannot be silently retried; preserve the row and reconcile before repair.
No plaintext contact details, email body or capture URL are stored in this table.

The hosted walkthrough stores edited fictional contacts only in React memory.
Reloading clears them. Synthetic attempt status remains isolated per fictional
party; editing contact details clears its old simulated outcome. The normal
app uses saved matter records and a durable backend. Status-only entry does
not start client capture for the attorney.

Remaining real-delivery dependencies: SMTP sending service/sender and private
credentials, approved verification/invitation schema and grants, reachable
Python hosting, existing authenticated DEEDLY deployment, and an explicitly
authorised test recipient. Existing Neon and Veriff connection checks do not
establish deployed email delivery.

Validation: 109 Python tests passed with one existing DB-gated class skipped;
34 selected frontend/proxy tests passed, including two new contact-form tests;
final targeted form/BFF rerun passed 23 tests after adding invitation forwarding
and the safe email configuration error code. Frontend/server test typechecks
and the harness build passed. Mounted local browser checks exercised invalid
country-code input, corrected contact review, required checkbox, the simulated
unsent receipt and the confirmed subject in the status panel. The hosted page
was opened successfully and its new contact form verified. No SMTP server or
real recipient was contacted. Schema proposals and backend email code remain
local and have not been activated in the hosted static walkthrough.
