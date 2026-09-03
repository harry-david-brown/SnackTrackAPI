import { AppError } from '../../core/errors';

type UnknownRecord = Record<string, unknown>;

const invalid = (field: string): never => {
  throw new AppError({
    code: 'GMAIL_PROVIDER_PAYLOAD_INVALID',
    message: `Invalid Gmail provider payload: ${field}`,
    publicMessage: 'Gmail returned an invalid response. Please try again.',
  });
};

const record = (value: unknown, field: string): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : invalid(field);

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : invalid(field);
};

export interface DecodedGmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface DecodedGmailPart {
  readonly mimeType?: string;
  readonly bodyData?: string;
  readonly headers: readonly DecodedGmailHeader[];
  readonly parts: readonly DecodedGmailPart[];
}

export interface DecodedGmailMessage {
  readonly id?: string;
  readonly internalDate?: string;
  readonly snippet?: string;
  readonly payload?: DecodedGmailPart;
  readonly sizeEstimate?: number;
}

const decodeHeader = (value: unknown, field: string, state: { headerBytes: number }): DecodedGmailHeader => {
  const header = record(value, field);
  const name = optionalString(header.name, `${field}.name`);
  const headerValue = optionalString(header.value, `${field}.value`);
  if (name === undefined || headerValue === undefined) return invalid(field);
  const bytes = Buffer.byteLength(name) + Buffer.byteLength(headerValue);
  state.headerBytes += bytes;
  if (bytes > 16 * 1024 || state.headerBytes > 256 * 1024) return invalid(field);
  return { name, value: headerValue };
};

const decodePart = (value: unknown, field: string, state: { parts: number; headers: number; headerBytes: number }, depth: number): DecodedGmailPart => {
  if (depth > 20) return invalid(`${field}.depth`);
  state.parts += 1;
  if (state.parts > 250) return invalid(`${field}.parts`);
  const part = record(value, field);
  const rawHeaders: unknown[] = Array.isArray(part.headers ?? [])
    ? ((part.headers as unknown[] | undefined) ?? [])
    : invalid(`${field}.headers`);
  const rawParts: unknown[] = Array.isArray(part.parts ?? [])
    ? ((part.parts as unknown[] | undefined) ?? [])
    : invalid(`${field}.parts`);
  state.headers += rawHeaders.length;
  if (state.headers > 250) return invalid(`${field}.headers`);
  const body =
    part.body === undefined || part.body === null ? undefined : record(part.body, `${field}.body`);
  if (typeof body?.data === 'string' && body.data.length > 1_500_000) return invalid(`${field}.body.data`);
  return {
    mimeType: optionalString(part.mimeType, `${field}.mimeType`),
    bodyData: optionalString(body?.data, `${field}.body.data`),
    headers: rawHeaders.map((entry, index) => decodeHeader(entry, `${field}.headers.${index}`, state)),
    parts: rawParts.map((entry, index) => decodePart(entry, `${field}.parts.${index}`, state, depth + 1)),
  };
};

export const decodeGmailMessage = (value: unknown): DecodedGmailMessage => {
  const response = record(value, 'messageResponse');
  const data = record(response.data, 'messageResponse.data');
  return {
    id: optionalString(data.id, 'messageResponse.data.id'),
    internalDate: optionalString(data.internalDate, 'messageResponse.data.internalDate'),
    snippet: optionalString(data.snippet, 'messageResponse.data.snippet'),
    payload:
      data.payload === undefined || data.payload === null
        ? undefined
        : decodePart(data.payload, 'messageResponse.data.payload', { parts: 0, headers: 0, headerBytes: 0 }, 0),
    sizeEstimate: typeof data.sizeEstimate === 'number' && Number.isFinite(data.sizeEstimate) ? data.sizeEstimate : undefined,
  };
};

export interface DecodedGmailList {
  readonly messageIds: readonly string[];
  readonly nextPageToken?: string;
}

export const decodeGmailMessageList = (value: unknown): DecodedGmailList => {
  const response = record(value, 'messageListResponse');
  const data = record(response.data, 'messageListResponse.data');
  const messages: unknown[] = Array.isArray(data.messages ?? [])
    ? ((data.messages as unknown[] | undefined) ?? [])
    : invalid('messageListResponse.data.messages');
  return {
    messageIds: messages.map((entry, index) => {
      const message = record(entry, `messageListResponse.data.messages.${index}`);
      const id = optionalString(message.id, `messageListResponse.data.messages.${index}.id`);
      return id && id.length > 0 ? id : invalid(`messageListResponse.data.messages.${index}.id`);
    }),
    nextPageToken: optionalString(data.nextPageToken, 'messageListResponse.data.nextPageToken'),
  };
};

export const decodeGmailProfile = (value: unknown): { readonly emailAddress: string } => {
  const response = record(value, 'profileResponse');
  const data = record(response.data, 'profileResponse.data');
  const emailAddress = optionalString(data.emailAddress, 'profileResponse.data.emailAddress');
  return emailAddress && emailAddress.includes('@')
    ? { emailAddress }
    : invalid('profileResponse.data.emailAddress');
};

export interface DecodedGoogleOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiryDate: Date;
  readonly scopes: readonly string[];
}

export const decodeGoogleOAuthTokens = (
  value: unknown,
  now: () => number = Date.now,
): DecodedGoogleOAuthTokens => {
  const response = record(value, 'tokenResponse');
  const tokens = record(response.tokens, 'tokenResponse.tokens');
  const accessToken = optionalString(tokens.access_token, 'tokenResponse.tokens.access_token');
  if (!accessToken) return invalid('tokenResponse.tokens.access_token');
  const refreshToken =
    optionalString(tokens.refresh_token, 'tokenResponse.tokens.refresh_token') ?? null;
  const rawExpiry = tokens.expiry_date;
  if (rawExpiry !== undefined && (typeof rawExpiry !== 'number' || !Number.isFinite(rawExpiry))) {
    invalid('tokenResponse.tokens.expiry_date');
  }
  const expiryDate = new Date(typeof rawExpiry === 'number' ? rawExpiry : now() + 60 * 60 * 1000);
  if (Number.isNaN(expiryDate.getTime())) invalid('tokenResponse.tokens.expiry_date');
  const rawScope = tokens.scope;
  if (rawScope !== undefined && typeof rawScope !== 'string') invalid('tokenResponse.tokens.scope');
  return {
    accessToken,
    refreshToken,
    expiryDate,
    scopes:
      typeof rawScope === 'string'
        ? rawScope
            .split(' ')
            .map((scope) => scope.trim())
            .filter(Boolean)
        : [],
  };
};

export const decodeGoogleUserInfoEmail = (value: unknown): string => {
  const response = record(value, 'userInfoResponse');
  const data = record(response.data, 'userInfoResponse.data');
  const email = optionalString(data.email, 'userInfoResponse.data.email');
  return email && email.includes('@') ? email : invalid('userInfoResponse.data.email');
};
