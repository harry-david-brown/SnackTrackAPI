# SnackTrack API Agent Guidance

This repository contains the SnackTrack Express/PostgreSQL API.

## Required skills

- Load `snacktrack-backend-engineering` for every route, service, repository, schema, migration, destructive mutation, background job, cache, concurrency, or production-data change in this repository.
- Load `snacktrack-codebase-navigation` before tracing ownership, planning cross-stack work, or editing an unfamiliar feature when that workspace skill is available.
- Also load `snacktrack-import-flow` for Gmail receipt imports, Uber/DoorDash exports, export-ready alerts, consent, OAuth health, ongoing tracking, deduplication, or import state machines.
- Also load `snacktrack-account-data-lifecycle` for clearing or restoring data, onboarding resets, provider cleanup, account deletion, privacy deletion, or fresh-account behavior.
- For cross-stack work, inspect the sibling `SnackTrackApp` repository and follow its `AGENTS.md` and applicable frontend skills before changing API contracts.

## Repository rules

- Keep routes responsible for authentication, validation, and response construction. Put durable business mutations in cohesive services and persistence logic in the established repository/data boundary.
- Define the response, stable machine-readable error codes, and postconditions before implementation. Never report a provider or persistence failure as a successful import.
- Use one transaction for writes that must succeed or roll back together. Acquire coordination locks before transactions or external calls, release them in `finally`, and ensure every writer follows the same protocol.
- Make startup migrations safe and idempotent for both fresh and existing databases. Account for triggers, constraints, indexes, and existing production data.
- Invalidate derived caches only after durable writes commit.
- Preserve explicit consent and user-scoped data boundaries. Use narrowly scoped, read-only queries for diagnosis and never expose credentials or unrelated user data.
- Preserve unrelated user changes and avoid unrelated rewrites.

## Verification

- Add or update focused regression tests at the service/repository boundary and for every affected route contract.
- Tests for mutations should verify postconditions, rollback and lock release, cache effects, stable error behavior, and realistic races where applicable.
- For ordinary code changes, run only `npm run build` as the API TypeScript check.
- Do not run focused tests, `npm test`, or other test suites unless the user explicitly requests them.
- iOS Simulator and Android Emulator testing, including app-driven end-to-end API checks, are outside the scope of agent tasks. Do not launch or control either environment unless the user explicitly requests it; the user will handle device and emulator verification.
- Do not treat the absence of Simulator or Emulator testing as incomplete verification. Clearly hand off any app-driven manual flows the user should check.
- Inspect the final diff for bypassed service boundaries, incomplete lock participation, unsafe migrations, stale caches, and swallowed errors.
