# Import navigation and export-ready alerts

Backend-first rollout; the client only offers background enrollment when the canonical provider preference reports readyAlert.backgroundAvailable.

## Deployment order

1. Deploy API migration 33 with EXPORT_READY_BACKGROUND_ENABLED=false. Run the API and workers from the same release. The migration adds provider consent, request identity and scheduling fields; existing Uber foreground consent is not copied into background consent. Existing unqualified endpoints remain Uber-only.
2. Verify the existing PostgreSQL outbox dispatcher, mailbox queue workers, notification workers and Expo delivery credentials on the target environment. Production capability remains off if push delivery is configured for logging.
3. Configure the scheduler service (npm run start:scheduler) to run every five minutes or more often. It is a one-shot process, not a continuously polling daemon. Durable provider timestamps target a check every 15 minutes; throttling and queue delays can extend this. Verify successive import_scheduler records and queue consumption before enabling enrollment.
4. Verify Gmail Pub/Sub authorization and watch renewal. Push triggers enqueue the same provider-scoped jobs; Outlook and Gmail fallback use the scheduler. Gmail watch failure does not remove scheduled coverage.
5. Enable EXPORT_READY_BACKGROUND_ENABLED=true consistently on API, scheduler and worker services only after these operational checks. Release the new client after confirming the capability response and device registration in the target environment.
6. Observe a consented pending request for each provider/mailbox combination while the app is closed. Verify exactly one ready transition and notification per registered device. Do not advertise an exact detection time.

No deployment or production configuration changes are performed by editing this repository.

## Contracts and consent

- PUT /gmail/preferences/provider-ready-alert-consent accepts provider, decision, consentVersion. Grant requires export-ready-background-v1; provider is uber_eats or doordash.
- POST /gmail/preferences/check-provider-ready accepts provider. Queues eligible work; it does not claim an email was detected.
- Provider preferences include requestId, separate alert consent/timestamps, mailbox capability and effective status. Device permission and device registration remain separate.
- Revoking legacy Uber consent also revokes expanded Uber monitoring. Granting legacy consent never grants expanded access or DoorDash consent.
- Old ready emails, receipts and request acknowledgements do not qualify. No download link is followed and no archive is fetched.
- Reset deletes provider preference rows and advances the existing import generation. Results and deliveries recheck current request identity, consent and generation.

## Operational verification

Use structured scheduler, job event and notification delivery records. Track overdue alert_next_check_at, job failures/retries, alert_last_error_code, transitions to file_ready, per-device delivery failures, reconnect requirements and attempts suppressed by request/generation checks. Never log email content, download URLs or tokens.

Background jobs are visible in Admin as **Export ready-email check**, but are excluded from the user's active/recent import selection and completion screens. Foreground imports retain priority over ready checks.

Rollback: disable the flag on all services and stop scheduling new ready checks. Keep the additive schema and new job decoder until pending work has drained. Existing consent stays stored; workers with the flag disabled perform no mailbox reads.

## Device verification checklist

- Enter Add orders from Home (including no orders), onboarding, History, Summary, Wrapped and Settings; Back from the overview returns to the entry destination, while Go home always reaches Home.
- Open both providers; verify saved waiting/ready/failed/processing states and provider switching. Reading another stage never changes saved lifecycle milestones.
- Check all 11 tutorial images, descriptions, fallback help, swipe, Previous/Next, enlargement and Android Back. Close enlargement on the same slide. Restart and verify guide position; switch account/provider/request cycle and verify isolation.
- Leave for the provider website, cancel or return without submitting, then explicitly confirm submission. A website visit alone must not create a request.
- Cancel the file picker; stay on the same page/guide. Select a file once, review its filename, then explicitly Upload and import. Double taps do not duplicate submission. Navigation is blocked only through transfer/submission, then processing may continue after leaving.
- Waiting: Enable stays on the waiting page. Go home prompts only when needed. Dismiss stays; Not now exits and is remembered for that request. A new request may prompt again.
- Enrollment: test Gmail and Outlook OAuth return, connection cancellation, reconnect, denied OS permission, registration failure, Retry and Go home. No historical receipt import starts during alert enrollment.
- Background: test Uber Eats and DoorDash with Gmail and Outlook, both providers waiting together, acknowledgements, receipts, stale ready mail, duplicate triggers and temporary provider failures.
- Revoke consent, disconnect the last mailbox, reset data or delete the account with queued work; no old request may reappear or notify. Disconnecting one mailbox retains coverage if the other is usable.
- Tap current and stale notifications with the app closed/open/signed out, during upload, and while already viewing the provider. Ready alerts must never open an import-result recap.
- Verify Settings revocation, large text, dark appearance, screen-reader stage/status announcements, sheet focus and reduced motion.

## Automated checks

Required compilation checks: app npm run type-check, API npm run build, Admin npm run type-check.

Regression tests were added/updated for provider detection, consent/request identity boundaries, independent jobs, ready-notification parsing, waiting-page enrollment/reminder behavior, navigation and explicit file submission. Test suites and simulators are intentionally not run without explicit user authorization.
