import {createHash} from 'crypto';
import {constants} from 'fs';
import {open} from 'fs/promises';
import {AppError} from '../../core/errors';
import type {ReceiptWriteCommand} from '../../models/Receipt';
import {MailboxMessage} from '../ports/MailboxPorts';
import type {RetainedReceiptSourceReadPort} from '../ports/ReceiptRepairAcquisitionPorts';
import {MailboxContentGuard} from '../mailbox/MailboxContentGuard';
import {evidenceFingerprint} from '../receipt/ReceiptEvidenceFingerprint';
import {decodeRetainedEmailDiagnostics, type RetainedEmailDiagnostics} from '../receipt/ReceiptRepairSources';
import type {ReceiptEmailBatchExtractor} from './ReceiptEmailBatchExtractor';

export const RETAINED_EMAIL_LIMIT_BYTES = 32 * 1024 * 1024;
export const RETAINED_EMAIL_MESSAGE_LIMIT = 1000;
type ReadInput = Parameters<RetainedReceiptSourceReadPort['read']>[0];
const invalid = (message = 'Invalid retained message bundle'): never => {
  throw new AppError({code:'INVALID_RETAINED_EMAILS',message});
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key=>allowed.includes(key));
const utcDate = (value: unknown): Date | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid('Invalid retained message date');
  return new Date(value);
};

/** Already-retained provider-neutral originals only. No mailbox client, network or raw-body persistence. */
export class RetainedEmailReader implements RetainedReceiptSourceReadPort {
  constructor(private readonly batch: Pick<ReceiptEmailBatchExtractor,'extract'>,
    private readonly guard = new MailboxContentGuard(3)) {}

  async read(input: ReadInput) {
    if (input.sourceKind !== 'retained_email' || (input.mailboxProvider !== 'gmail' && input.mailboxProvider !== 'microsoft'))
      return invalid('The retained email reader requires a selected mailbox provider');
    const {bytes,artifact} = await this.readSnapshot(input.path);
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { return invalid('Retained messages must be a valid UTF-8 JSON bundle'); }
    if (!record(decoded) || !onlyKeys(decoded,['version','userId','mailboxProvider','messages']) || decoded.version !== 1 ||
      decoded.userId !== input.userId || decoded.mailboxProvider !== input.mailboxProvider ||
      !Array.isArray(decoded.messages) || decoded.messages.length > RETAINED_EMAIL_MESSAGE_LIMIT)
      return invalid('Retained message bundle has an incompatible account, provider, version or size');

    const diagnostics: RetainedEmailDiagnostics = {version:1, mailboxProvider:input.mailboxProvider,
      sourceMessages:decoded.messages.length, duplicateMessages:0, acceptedMessages:0,
      rejected:{message_too_large:0,body_too_large:0,sender_not_allowed:0,dmarc_failed:0,provider_payload_invalid:0,
        unsupported_receipt:0,different_delivery_provider:0,extraction_failed:0}};
    const messages: MailboxMessage[] = [];
    const identities = new Map<string,string>();
    for (const value of decoded.messages) {
      // Never invent a provider ID, received date or original body from a parsed receipt or screenshot.
      if (!record(value) || !onlyKeys(value,['providerMessageId','from','to','body','subject','receivedAt','authenticationHeaders']) ||
        typeof value.providerMessageId !== 'string' || !/^[A-Za-z0-9_+=./-]{1,512}$/.test(value.providerMessageId) ||
        typeof value.from !== 'string' || typeof value.to !== 'string' || typeof value.body !== 'string' ||
        (value.subject !== undefined && typeof value.subject !== 'string') ||
        (value.authenticationHeaders !== undefined && (!Array.isArray(value.authenticationHeaders) ||
          value.authenticationHeaders.length > 50 || !value.authenticationHeaders.every(v=>typeof v === 'string'))))
        return invalid('Retained messages require original provider identifiers, sender, recipient and body fields');
      const receivedAt = utcDate(value.receivedAt);
      const identity = evidenceFingerprint(value);
      const previous = identities.get(value.providerMessageId);
      if (previous) {
        if (previous !== identity) return invalid('Conflicting copies of one provider message require review');
        diagnostics.duplicateMessages++; continue;
      }
      identities.set(value.providerMessageId,identity);
      const headers = value.authenticationHeaders === undefined ? [] : value.authenticationHeaders;
      // Strict original-message safety: a repair file cannot opt into forwarded-sender exceptions.
      const preflight = this.guard.preflight({provider:input.mailboxProvider,from:value.from,to:value.to,subject:value.subject,
        authenticationHeaders:headers,providerBytes:Buffer.byteLength(JSON.stringify(value)),allowForwardedReceipts:false});
      const guarded = this.guard.acceptBody(value.body,preflight);
      if (!guarded.accepted) { diagnostics.rejected[guarded.reason ?? 'provider_payload_invalid']++; continue; }
      messages.push(new MailboxMessage(input.userId,value.from,value.to,guarded.body,value.subject,value.providerMessageId,receivedAt,input.mailboxProvider));
    }
    const receipts: ReceiptWriteCommand[] = [];
    // Bound each extraction batch; preserve message-level loss counts without outputting content or IDs.
    for (let i=0;i<messages.length;i+=25) {
      const group=messages.slice(i,i+25);
      const result=await this.batch.extract(group,input.timezone,{userId:input.userId,trigger:'manual'});
      const selected=result.supportedReceipts.filter(r=>r.receiptType===input.provider);
      diagnostics.acceptedMessages+=selected.length;
      diagnostics.rejected.unsupported_receipt+=result.nonReceiptCount+result.nonFoodCount;
      diagnostics.rejected.different_delivery_provider+=result.supportedReceipts.length-selected.length;
      diagnostics.rejected.extraction_failed+=result.errors.length;
      receipts.push(...selected);
    }
    const emailDiagnostics=decodeRetainedEmailDiagnostics(diagnostics);
    const rejectedRecords=Object.values(emailDiagnostics.rejected).reduce((a,b)=>a+b,0);
    return {artifact,receipts,rejectedRecords,successfulCompletion:receipts.length>0 && rejectedRecords===0,emailDiagnostics};
  }

  private async readSnapshot(path: string) {
    const source=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const before=await source.stat();
      if (!before.isFile() || before.size<=0 || before.size>RETAINED_EMAIL_LIMIT_BYTES)
        return invalid('A nonempty regular retained-message file within the size limit is required');
      const parts: Buffer[]=[]; let sizeBytes=0;
      for await (const part of source.createReadStream({autoClose:false})) {
        const chunk: Buffer=Buffer.isBuffer(part) ? part : Buffer.from(part);
        sizeBytes+=chunk.length;
        if (sizeBytes>RETAINED_EMAIL_LIMIT_BYTES) return invalid('Retained messages exceed the size limit');
        parts.push(chunk);
      }
      const after=await source.stat();
      if (sizeBytes!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)
        throw new AppError({code:'REPAIR_SOURCE_CHANGED',message:'Retained messages changed while being read; preview them again'});
      const bytes=Buffer.concat(parts,sizeBytes);
      return {bytes,artifact:{sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes}};
    } finally { await source.close(); }
  }
}
