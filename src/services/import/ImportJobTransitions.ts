import type { ImportJobStatus } from './ImportJobTypes';

/** Source states only. Generation, expiry, heartbeat, and ownership guards stay in SQL. */
export const IMPORT_JOB_TRANSITION_SOURCES = {
  submitUpload: ['awaiting_upload'],
  queue: ['pending_dispatch', 'retrying'],
  claim: ['pending_dispatch', 'queued', 'running', 'retrying'],
  supersedeUnclaimed: ['pending_dispatch', 'queued', 'retrying'],
  progress: ['running'],
  retry: ['running'],
  finish: ['running'],
  supersedeActive: ['awaiting_upload', 'pending_dispatch', 'queued', 'running', 'retrying'],
  expireUpload: ['awaiting_upload'],
  cancelPending: ['pending_dispatch', 'queued', 'retrying'],
  recoverStale: ['queued', 'running', 'retrying'],
} as const satisfies Record<string, readonly ImportJobStatus[]>;

export type ImportJobTransition = keyof typeof IMPORT_JOB_TRANSITION_SOURCES;
