# Gmail Pub/Sub setup

SnackTrack uses Gmail push notifications as a mailbox-change signal. The webhook never reads email. It authenticates Google, validates a bounded payload, and coalesces repeated notifications in PostgreSQL. The worker performs a narrow Gmail search after the debounce window.

## Google Cloud resources

1. Create one Pub/Sub topic in the same Google Cloud project as the Gmail API OAuth client.
2. Grant `roles/pubsub.publisher` on that topic to `gmail-api-push@system.gserviceaccount.com`.
3. Create a dedicated service account that can only authenticate Pub/Sub push delivery. It does not need Gmail or database permissions.
4. Create a push subscription for `https://<api-host>/webhooks/gmail/pubsub`.
5. Enable authenticated push, using the dedicated service account. Set the OIDC audience to the exact webhook URL.
6. Configure a dead-letter topic and alert on sustained delivery failures.

The subscription, topic, OAuth client, and Gmail API must use the same Google Cloud project. See Google's [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push).

## API configuration

Set all four push values together:

```dotenv
GMAIL_PUBSUB_TOPIC=projects/<project>/topics/gmail-mailbox-updates
GMAIL_PUBSUB_SUBSCRIPTION=projects/<project>/subscriptions/gmail-mailbox-updates-push
GMAIL_PUBSUB_AUDIENCE=https://<api-host>/webhooks/gmail/pubsub
GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL=<push-service-account>@<project>.iam.gserviceaccount.com
```

Safety defaults reserve headroom below Google's published limits:

```dotenv
GMAIL_PROJECT_QUERY_UNITS_PER_MINUTE=600000
GMAIL_PROJECT_QUERY_UNITS_PER_DAY=60000000
GMAIL_USER_QUERY_UNITS_PER_MINUTE=4000
GMAIL_PUSH_DEBOUNCE_SECONDS=30
```

Deploy the API, worker, and hourly scheduler. The worker dispatches due wake-ups every ten seconds. The scheduler renews watches with a two-day cadence and five-day expiration buffer, retains Outlook's provider-specific polling, and removes old quota rows. It does not scan Gmail mailboxes; Gmail monitoring work starts only from an authenticated Pub/Sub notification.

## Operational checks

- Run migration 23 before accepting webhook traffic.
- Confirm an enabled user has a future `watch_expiration` in `gmail_push_state`.
- Send a test message to the watched inbox and confirm notifications are coalesced before one `gmail_push_tracking` job is created.
- Confirm forged tokens receive `401`, while authenticated malformed or stale mailbox notifications are acknowledged without creating work.
- Check **Gmail usage** in the admin dashboard. Warning begins near 40 million daily units and the server stops reserving work at the configured 60 million-unit safety limit.
- Verify disconnect, onboarding reset, and account deletion call Gmail `stop` and clear local push state.

Do not give the push service account project-wide editor permissions, log notification payloads, or route the webhook through user-facing IP throttles.
