import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { redactLogMetadata } from '../../config/logger';
import type { StructuredLogger } from '../core/StructuredLogger';
import type { EmailDebugCapturePort } from '../ports/MailboxPorts';

export class DisabledEmailDebugCapture implements EmailDebugCapturePort {
  capture(): Promise<void> {
    return Promise.resolve();
  }
}

/** Writes redacted operational summaries only; raw addresses, bodies, and receipt payloads are forbidden. */
export class RedactingFileEmailDebugCapture implements EmailDebugCapturePort {
  constructor(
    private readonly enabled: boolean,
    private readonly logger: StructuredLogger,
    private readonly directory = path.join(process.cwd(), 'debug-events'),
  ) {}

  async capture(event: string, metadata: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.enabled) return;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const record = {
        event,
        recordedAt: new Date().toISOString(),
        metadata: redactLogMetadata(metadata),
      };
      await fs.writeFile(
        path.join(this.directory, `${event}-${randomUUID()}.json`),
        JSON.stringify(record, null, 2),
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      this.logger.warn('Redacted email debug capture failed', {
        operation: 'email_debug_capture',
        outcome: 'failure',
        event,
        error,
      });
    }
  }
}
