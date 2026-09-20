import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { PushDeviceRepository } from './PushDeviceRepository';
import { importCompletionResult } from '../import/ImportCompletionResult';

export class ImportPushNotificationService {
  private readonly expo = new Expo();

  constructor(
    private readonly jobs: ImportJobRepository,
    private readonly devices: PushDeviceRepository,
    private readonly mode: 'log'|'expo',
    private readonly logger: { info(message: string, metadata: Readonly<Record<string,unknown>>): void },
  ) {}

  async notify(jobId: string): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    const succeeded = job.status === 'succeeded';
    const completion = importCompletionResult(job.result);
    const exportReady = succeeded && job.result?.exportReadyDetected === true;
    const scheduledDetection = succeeded && job.trigger === 'scheduler' && completion.hasChanges && !exportReady;
    if (succeeded && job.trigger === 'scheduler' && !completion.hasChanges && !exportReady) return;
    const devices = await this.devices.listEnabled(job.userId);
    if (!devices.length) return;
    const title = exportReady
      ? 'Your Uber data is ready'
      : scheduledDetection ? completion.title
      : succeeded ? 'SnackTrack import complete' : 'SnackTrack import needs attention';
    const body = exportReady
      ? 'Open SnackTrack to continue importing your history.'
      : succeeded
        ? completion.body
        : 'Open SnackTrack to review the issue and try again.';
    if (this.mode === 'log') {
      this.logger.info('Push notification logged in development', { operation: 'import_push', jobId, userId: job.userId, deviceCount: devices.length, title, body });
      return;
    }
    const eligible = devices.filter((device) => Expo.isExpoPushToken(device.token));
    const messages: ExpoPushMessage[] = eligible.map((device) => ({
      to: device.token,
      sound: 'default',
      title,
      body,
      data: { type: 'import_operation', operationId: job.id, route: '/(tabs)/upload' },
    }));
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      tickets.push(...await this.expo.sendPushNotificationsAsync(chunk));
    }
    for (let index = 0; index < eligible.length; index += 1) {
      const device = eligible[index];
      const ticket = tickets[index];
      if (ticket?.status === 'ok') {
        await this.devices.recordDelivery(job.id, device.id, 'sent', ticket.id);
      } else {
        const code = ticket?.status === 'error' ? ticket.details?.error : 'PUSH_FAILED';
        const disabled = code === 'DeviceNotRegistered';
        if (disabled) await this.devices.markDisabled(device.id);
        await this.devices.recordDelivery(job.id, device.id, disabled ? 'device_disabled' : 'failed', undefined, code);
      }
    }
  }

  async processReceipts(): Promise<number> {
    if (this.mode === 'log') return 0;
    const pending = await this.devices.listPendingReceipts();
    let processed = 0;
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(pending.map((entry) => entry.ticketId))) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const entry of pending.filter((candidate) => chunk.includes(candidate.ticketId))) {
        const receipt = receipts[entry.ticketId];
        if (!receipt) continue;
        processed += 1;
        if (receipt.status === 'ok') {
          await this.devices.recordReceipt(entry.deliveryId, 'delivered');
        } else {
          const code = receipt.details?.error ?? 'PUSH_RECEIPT_FAILED';
          const disabled = code === 'DeviceNotRegistered';
          if (disabled) await this.devices.markDisabled(entry.deviceId);
          await this.devices.recordReceipt(entry.deliveryId, disabled ? 'device_disabled' : 'failed', code);
        }
      }
    }
    return processed;
  }
}
