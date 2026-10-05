// Voo Connect, ESM entry. Same API as index.js (CommonJS): import { createVooConnect } from './voo-connect/index.mjs';
import vooConnect from './index.js';

export const {
  VERSION, createVooConnect, VooError, EventsClient, normalizeEvent, verifyJwtHS256, verifyHmac, verifyGatevooSignature, signHmac,
  memoryStore, fileStore, parseCookies, cookieString, appendCookie, safeReturnTo, readBody, mergeAttribution, cleanAttribution, encodeAttribution, decodeAttribution,
  MAX_BATCH, ATTR_COOKIE, STATE_COOKIE, MONEY_TYPES, SIGNAL_KEYS,
} = vooConnect;
export default vooConnect;
