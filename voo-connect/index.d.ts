// Types for Voo Connect (sdk/voo-connect). Works for CommonJS (require) and ESM (import).
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const VERSION: string;
export declare const MAX_BATCH: 100;
export declare const ATTR_COOKIE: 'voo_attr';
export declare const STATE_COOKIE: 'voo_state';
export declare const MONEY_TYPES: ReadonlyArray<'spend' | 'refund' | 'chargeback' | 'wallet_topup' | 'plan_started' | 'plan_renewed'>;
export declare const SIGNAL_KEYS: ReadonlyArray<SignalKey>;

type Req = IncomingMessage & { originalUrl?: string; body?: unknown; rawBody?: Buffer | string; vooAttribution?: Attribution };
type Res = ServerResponse;
type Next = (err?: unknown) => void;
export type Handler = (req: Req, res: Res, next?: Next) => void | Promise<void>;

export declare class VooError extends Error {
  /** invalid_grant, invalid_client, state_missing, state_mismatch, state_expired, access_denied, invalid_id_token, invalid_event, network, unauthorized, config, ... */
  code: string;
  status?: number;
  retryable?: boolean;
  data?: unknown;
  constructor(code: string, message?: string, extra?: Record<string, unknown>);
}

export interface Attribution { ref?: string; vclick?: string; coupon?: string }

/** The member, as VooSquare sends it. Find or create your user by voo_id, never by email. */
export interface VooUser {
  voo_id: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  /** ISO 2-letter country: use it to choose local or global payment methods. */
  country: string;
  /** The referral code: save it once on first login, never change it. */
  voo_ref: string;
  premium: boolean;
  picture: string;
}
export interface IdTokenClaims extends Partial<VooUser> { sub: string; aud: string; iss: string; iat: number; exp: number; [k: string]: unknown }
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; id_token: string; user: VooUser; [k: string]: unknown }
export interface CallbackResult { user: VooUser; claims: IdTokenClaims; tokens: TokenResponse; returnTo: string }

export type SignalKey = 'payment_fingerprint' | 'telegram_id_hash' | 'phone_hash' | 'device_hash' | 'payment_country';
export type Signals = Partial<Record<SignalKey, string>>;

/** One event in VooSquare's wire format (POST /api/v1/events). */
export interface WireEvent {
  event_id: string;
  type: 'spend' | 'refund' | 'chargeback' | 'plan_started' | 'plan_renewed' | 'plan_cancelled' | 'wallet_topup' | (string & {});
  voo_id?: string;
  value_usd?: number;
  label?: string;
  plan?: string;
  country?: string;
  occurred_at?: string | number | Date;
  original_event_id?: string;
  signals?: Signals;
}
/** Friendly form used by voo.events.spend() and friends. */
export interface MoneyEvent {
  /** Stable id: the same payment must always give the same id (use voo.events.id('pay', paymentId)). Max 80 chars. */
  eventId: string;
  vooId: string;
  /** US dollars, > 0 (at least 0.01). Never negative. */
  valueUsd: number;
  plan?: string;
  label?: string;
  country?: string;
  /** The real payment time. Default: now. */
  occurredAt?: string | number | Date;
  /** For refund and chargeback: the eventId of the spend. Required for chargeback. */
  originalEventId?: string;
  signals?: Signals;
}
export interface ActivityEvent { eventId: string; vooId?: string; valueUsd?: number; label?: string; plan?: string; country?: string; occurredAt?: string | number | Date }

export interface OutboxItem { event: WireEvent; attempts: number; next: number; queued_at: number; resends?: number }
export interface OutboxStore { load(): OutboxItem[]; save(items: OutboxItem[]): void }
export interface FlushResult { calls: number; stored: number; resent: number; rejected: Array<{ event_id: string; error: string }>; retrying: number; pending: number }

export declare class EventsClient {
  stats: { calls: number; stored: number; resent: number; retries: number; rejected: number };
  /** Stable event id with the tool prefix: id('pay', 184) → "jv_pay_184". */
  id(...parts: Array<string | number | Date>): string;
  track(event: WireEvent): WireEvent;
  spend(e: MoneyEvent): WireEvent;
  refund(e: MoneyEvent): WireEvent;
  chargeback(e: MoneyEvent & { originalEventId: string }): WireEvent;
  planStarted(e: MoneyEvent & { plan: string }): WireEvent;
  planRenewed(e: MoneyEvent & { plan: string }): WireEvent;
  planCancelled(e: Omit<MoneyEvent, 'valueUsd'> & { valueUsd?: number }): WireEvent;
  walletTopup(e: MoneyEvent): WireEvent;
  activity(type: string, e: ActivityEvent): WireEvent;
  pending(): WireEvent[];
  failures(): Array<WireEvent & { error: string }>;
  flush(): Promise<FlushResult>;
  drain(opts?: { timeoutMs?: number }): Promise<{ pending: number; failed: number; last: FlushResult | null }>;
  start(intervalMs?: number): this;
  stop(): this;
}

export interface VooConnectOptions {
  /** Public VooSquare address, e.g. https://voosquare.com (env VOO_BASE). */
  base?: string;
  /** Address used for server-to-server calls when it differs (private network). Default: base (env VOO_SERVER_BASE). */
  serverBase?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  /** Your callback, exactly as registered in Admin → Products (env VOO_REDIRECT_URI). */
  redirectUri?: string;
  /** Prefix for event ids made by events.id(), e.g. "jv". */
  eventPrefix?: string;
  /** false for Affleego: no ref/vclick/coupon hand-off. */
  affiliate?: boolean;
  /** Where to land after login when no return_to is given. Default /dashboard. */
  defaultReturnTo?: string;
  /** Force the Secure flag on cookies (default: on when the request came over https or X-Forwarded-Proto: https). */
  secureCookies?: boolean;
  /** Share voo_attr with subdomains, e.g. ".joinvoo.com". */
  cookieDomain?: string;
  /** Signs the login state cookie. Default: derived from the client secret. */
  cookieSecret?: string;
  /** Key for hashSignal(). Default: env VOO_SIGNAL_SECRET, else derived from the client secret. Keep it stable. */
  signalSecret?: string;
  /** Keep the event outbox in this JSON file (survives restarts). */
  outboxFile?: string;
  /** Or keep it in your own database. */
  store?: OutboxStore;
  batchSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  toolName?: string;
  issuer?: string;
  onRejected?: (event: WireEvent, error: string) => void;
  onError?: (err: VooError) => void;
  fetch?: typeof fetch;
}

export interface SummaryMetric { key: string; label: string; value: number; unit?: 'count' | 'usd' | 'pct' | (string & {}); change_pct?: number }
export interface SummaryResult { status?: 'active' | 'trial' | 'paused' | (string & {}); metrics: SummaryMetric[]; open_url?: string }
export interface SupportReply { type: 'support.reply'; ticket_id: number; external_ref: string; email: string; body: string; agent: string; created_at: number }

export interface VooConnect {
  version: string;
  base: string;
  serverBase: string;
  clientId: string;
  redirectUri: string;
  affiliate: boolean;
  authorizeUrl(o: { state: string; prompt?: 'signup'; ref?: string; vclick?: string; coupon?: string; redirectUri?: string }): string;
  /** Mount at /auth/voosquare. Reads ?return_to= and ?signup=1. Redirects to VooSquare. */
  startLogin(req: Req, res: Res, opts?: { returnTo?: string; signup?: boolean; redirectUri?: string }): string;
  /** Mount at /auth/voosquare/callback. Then find/create your user by user.voo_id, set your session, redirect to returnTo. */
  handleCallback(req: Req, res: Res, opts?: { redirectUri?: string }): Promise<CallbackResult>;
  exchangeCode(code: string, opts?: { redirectUri?: string }): Promise<TokenResponse>;
  verifyIdToken(token: string, opts?: { clockToleranceSec?: number; now?: number }): IdTokenClaims;
  userinfo(accessToken: string): Promise<VooUser>;
  logoutUrl(returnTo?: string): string;
  /** Middleware for every landing page: keeps ref/vclick/coupon in the voo_attr cookie. */
  captureAttribution(): Handler;
  readAttribution(req: Req): Attribution;
  clearAttribution(res: Res, req?: Req): void;
  events: EventsClient;
  support: {
    send(m: { body: string; email?: string; name?: string; subject?: string; externalRef?: string; vooId?: string }): Promise<{ ok: true; ticket_id: number }>;
    thread(ticketId: number | string): Promise<{ ticket: { id: number; status: string; subject: string }; messages: Array<{ id: number; author_type: string; author_name: string; body: string; created_at: number }> }>;
  };
  users: { get(vooId: string): Promise<VooUser & { aud: string; iss: string }> };
  isFromVooSquare(req: Req): boolean;
  summaryHandler(fn: (vooId: string, period: '1d' | '7d' | '30d') => SummaryResult | null | undefined | Promise<SummaryResult | null | undefined>, opts?: { timeoutMs?: number }): Handler;
  supportWebhook(fn: (reply: SupportReply) => void | Promise<void>): Handler;
  hashSignal(value: string): string;
}

export declare function createVooConnect(options?: VooConnectOptions): VooConnect;
export declare function normalizeEvent(e: WireEvent, opts?: { now?: number }): WireEvent & { occurred_at: string };
export declare function verifyJwtHS256(token: string, secret: string, opts?: { audience?: string; issuer?: string; clockToleranceSec?: number; now?: number }): IdTokenClaims;
/** Constant-time HMAC-SHA256 hex check over the exact raw body (Gatevoo's X-Gatevoo-Signature). */
export declare function verifyHmac(rawBody: string | Buffer, signature: string, secret: string): boolean;
export declare const verifyGatevooSignature: typeof verifyHmac;
export declare function signHmac(rawBody: string | Buffer, secret: string): string;
export declare function memoryStore(): OutboxStore;
export declare function fileStore(file: string): OutboxStore;
export declare function parseCookies(header?: string): Record<string, string>;
export declare function cookieString(name: string, value: string, o?: { maxAge?: number; httpOnly?: boolean; secure?: boolean; domain?: string; sameSite?: 'Lax' | 'Strict' | 'None'; path?: string }): string;
export declare function appendCookie(res: Res, cookie: string): void;
export declare function safeReturnTo(v: unknown, fallback?: string): string;
export declare function readBody(req: Req, limit?: number): Promise<string>;
export declare function mergeAttribution(kept: Attribution & { t?: number }, fresh: Record<string, unknown>, at?: number): Attribution & { t?: number };
export declare function cleanAttribution(o: Record<string, unknown>): Attribution;
export declare function encodeAttribution(a: Attribution & { t?: number }): string;
export declare function decodeAttribution(s: string): Attribution & { t?: number };

declare const _default: {
  VERSION: typeof VERSION; createVooConnect: typeof createVooConnect; VooError: typeof VooError; EventsClient: typeof EventsClient;
  normalizeEvent: typeof normalizeEvent; verifyJwtHS256: typeof verifyJwtHS256; verifyHmac: typeof verifyHmac; verifyGatevooSignature: typeof verifyHmac; signHmac: typeof signHmac;
  memoryStore: typeof memoryStore; fileStore: typeof fileStore; parseCookies: typeof parseCookies; cookieString: typeof cookieString; appendCookie: typeof appendCookie;
  safeReturnTo: typeof safeReturnTo; readBody: typeof readBody; mergeAttribution: typeof mergeAttribution; cleanAttribution: typeof cleanAttribution;
  encodeAttribution: typeof encodeAttribution; decodeAttribution: typeof decodeAttribution;
  MAX_BATCH: typeof MAX_BATCH; ATTR_COOKIE: typeof ATTR_COOKIE; STATE_COOKIE: typeof STATE_COOKIE; MONEY_TYPES: typeof MONEY_TYPES; SIGNAL_KEYS: typeof SIGNAL_KEYS;
};
export default _default;
