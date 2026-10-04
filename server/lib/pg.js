'use strict';

/*
 * ============================================================================
 *  pg.js — a small, dependency-free PostgreSQL client for Node.js 22
 * ============================================================================
 *
 *  Uses only Node built-ins (net, tls, crypto, events). Speaks the PostgreSQL
 *  wire protocol v3 directly.
 *
 *  QUICK START
 *  -----------
 *    const { createPool } = require('./server/lib/pg');
 *
 *    const pool = createPool({
 *      connectionString: process.env.DATABASE_URL, // postgres://user:pass@host:5432/db?sslmode=require
 *      max: 10,                  // max open connections (default 10)
 *      idleTimeoutMs: 30000,     // close connections idle this long (default 30000, 0 = never)
 *      connectTimeoutMs: 10000,  // max time to open + authenticate a connection (default 10000, 0 = none)
 *      statementTimeoutMs: 0,    // server-side statement_timeout per connection (default 0 = off)
 *      ssl: undefined,           // true | false | tls options object; overrides ?sslmode (see SSL below)
 *      application_name: 'castvoo',
 *    });
 *
 *    // 1. Normal queries. ALWAYS pass user input as $1, $2 ... parameters,
 *    //    never by building SQL strings yourself (SQL injection!).
 *    const { rows, rowCount, command } = await pool.query(
 *      'select id, email from users where id = $1', [userId]);
 *    // rows     -> array of plain objects, e.g. [{ id: 1, email: 'a@b.c' }]
 *    // rowCount -> rows returned / inserted / updated / deleted (null for e.g. CREATE TABLE)
 *    // command  -> 'SELECT', 'INSERT', 'UPDATE', ...
 *    // fields   -> [{ name, dataTypeID }] column metadata
 *
 *    // 2. Many statements in one string (migrations). No parameters allowed.
 *    //    All statements run in one implicit transaction: if one fails, none apply
 *    //    (unless the script contains its own BEGIN/COMMIT).
 *    const results = await pool.simple('create table a(x int); insert into a values (1);');
 *    // results -> one { rows, rowCount, command, fields } per statement
 *
 *    // 3. Transactions. Runs BEGIN, your callback, then COMMIT.
 *    //    If the callback throws, ROLLBACK is run and the error is re-thrown.
 *    //    Use the `client` you are given (NOT pool.query) inside the callback,
 *    //    otherwise your query runs on another connection, outside the transaction.
 *    const orderId = await pool.tx(async (client) => {
 *      const { rows } = await client.query('insert into orders(user_id) values ($1) returning id', [userId]);
 *      await client.query('update users set order_count = order_count + 1 where id = $1', [userId]);
 *      return rows[0].id;   // pool.tx resolves with whatever the callback returns
 *    });
 *    // NOTE: nesting pool.tx(...) inside a tx callback is NOT supported. The inner
 *    // call would grab a different connection (it is not a savepoint), and with a
 *    // small pool it can deadlock waiting for a free connection. Use
 *    // client.query('savepoint x') yourself if you need nested behaviour.
 *
 *    // 4. Lower level: borrow one connection. You MUST release it in `finally`,
 *    //    otherwise the pool slowly runs out of connections.
 *    const client = await pool.connect();
 *    try { await client.query('select 1'); } finally { client.release(); }
 *    // client.release(true) destroys the connection instead of reusing it.
 *
 *    pool.stats();     // { total, idle, waiting }
 *    await pool.end(); // close everything (e.g. on SIGTERM). Waits for borrowed clients.
 *
 *  PARAMETER CONVERSION (JS -> PostgreSQL), all sent as text:
 *    null / undefined   -> NULL
 *    true / false       -> 't' / 'f'
 *    number / bigint    -> String(value)
 *    Date               -> ISO 8601 string in UTC (e.g. 2024-01-02T03:04:05.000Z)
 *    Buffer/Uint8Array  -> bytea hex format '\x....'
 *    Array              -> PostgreSQL array literal '{...}' (nested arrays, nulls, quoting handled)
 *                          e.g. pool.query('select * from t where id = any($1)', [[1, 2, 3]])
 *    plain object       -> JSON.stringify(value)
 *    anything else      -> String(value)
 *  CAREFUL: a JS *array* is always sent as a Postgres array. To store a JSON array
 *  in a json/jsonb column, pass JSON.stringify(myArray) yourself.
 *
 *  RESULT CONVERSION (PostgreSQL -> JS), by column type:
 *    int2, int4, oid          -> number
 *    int8 (bigint, count(*))  -> number if it fits in Number.MAX_SAFE_INTEGER, else string
 *    float4, float8           -> number (NaN / Infinity supported)
 *    numeric / decimal        -> number. CAVEAT: JS numbers hold ~15-17 significant digits,
 *                                so very large or very precise numerics (e.g. money with many
 *                                decimals) lose precision. Cast to ::text in SQL to get the
 *                                exact string when that matters.
 *    bool                     -> boolean
 *    json, jsonb              -> parsed with JSON.parse
 *    timestamptz              -> Date (microseconds truncated to milliseconds)
 *    timestamp (no time zone) -> Date, interpreted as UTC. Every connection starts with
 *                                TimeZone=UTC so this is consistent (SET TIME ZONE to change).
 *    'infinity'/'-infinity'   -> Infinity / -Infinity (for timestamp/timestamptz)
 *    date                     -> 'YYYY-MM-DD' string (avoids time zone surprises)
 *    bytea                    -> Buffer
 *    text, varchar, char, uuid, name, citext, and any type not listed -> string
 *    arrays of the types above (int2[], int4[], int8[], text[], varchar[], uuid[], bool[],
 *    float4[], float8[], numeric[], json[], jsonb[], timestamp[], timestamptz[], date[],
 *    bytea[], ...) -> JS arrays (nested for multi-dimensional arrays, NULL -> null)
 *  If two columns have the same name (e.g. "select a.id, b.id"), the last one wins.
 *  Use aliases ("select a.id as a_id, b.id as b_id").
 *
 *  ERRORS
 *    Errors from the server are `DatabaseError` (a subclass of Error) with:
 *      message (server message), code (SQLSTATE, e.g. '23505' unique violation),
 *      detail, hint, constraint, table, column, schema, dataType, severity,
 *      position, where, routine, and `query` (the SQL text, max 500 chars).
 *    After a query error the connection stays usable.
 *    Network errors (ECONNRESET, server restarts, pg_terminate_backend, ...)
 *    reject the query that was running; the broken connection is thrown away and
 *    the next query automatically gets a fresh connection. pool.query() retries
 *    ONCE, automatically, only when it is certain the server never started the
 *    statement (the connection had been shut down by the server before the query
 *    reached it). Transactions are never retried.
 *    The pool emits 'error' when an IDLE connection dies. If you don't listen for
 *    it the error is logged with console.error; it never crashes the process.
 *
 *  SSL (from ?sslmode=... in the URL, or the `ssl` option which wins):
 *    disable (or absent)  -> plain TCP
 *    prefer               -> try SSL; if the server says it has no SSL, use plain TCP
 *    require / no-verify  -> SSL required, but the certificate is NOT verified.
 *        This is deliberate: Railway's public TCP proxy (and many hosted databases)
 *        present certificates that do not match the hostname / are not signed by a
 *        public CA, so verification would always fail. The connection is still
 *        encrypted, but not protected against an active man-in-the-middle.
 *        Prefer Railway's private network (*.railway.internal) where possible.
 *    verify-ca / verify-full -> SSL with full certificate + hostname verification
 *        (pass `ssl: { ca: fs.readFileSync('root.crt') }` for private CAs).
 *    ssl: true  -> like require.   ssl: false -> like disable.
 *    ssl: { ...tls options } -> SSL required, options passed to tls.connect
 *        (rejectUnauthorized defaults to false unless you set it).
 *
 *  LIMITATIONS (by design, to keep this small)
 *    - Text format only; no prepared-statement cache (each query is parsed again).
 *    - No COPY support (COPY ... FROM STDIN fails with an error, COPY TO STDOUT
 *      output is discarded), no LISTEN/NOTIFY API, no query cancellation, no
 *      cursors/streaming: the whole result is held in memory.
 *    - SCRAM without channel binding (SCRAM-SHA-256-PLUS is not used). Passwords
 *      are normalized with NFKC, which matches SASLprep for practically all
 *      passwords but is not a complete SASLprep implementation.
 *    - Auth methods: trust, password (cleartext), md5, scram-sha-256 only.
 *      Kerberos/GSSAPI/SSPI/certificate auth are rejected with a clear error.
 *    - Unix domain sockets are not supported (TCP only).
 *    - One query at a time per connection (queries on the same client queue up).
 * ============================================================================
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION_3 = 196608; // 3 << 16
const SSL_REQUEST_CODE = 80877103;
const MAX_QUERY_TEXT_IN_ERRORS = 500;
const MAX_PARAMETERS = 65535;

// Backend (server -> client) message type bytes.
const BACKEND = {
  AUTHENTICATION: 0x52, // 'R'
  PARAMETER_STATUS: 0x53, // 'S'
  BACKEND_KEY_DATA: 0x4b, // 'K'
  READY_FOR_QUERY: 0x5a, // 'Z'
  ERROR_RESPONSE: 0x45, // 'E'
  NOTICE_RESPONSE: 0x4e, // 'N'
  NOTIFICATION_RESPONSE: 0x41, // 'A'
  ROW_DESCRIPTION: 0x54, // 'T'
  NO_DATA: 0x6e, // 'n'
  DATA_ROW: 0x44, // 'D'
  COMMAND_COMPLETE: 0x43, // 'C'
  EMPTY_QUERY_RESPONSE: 0x49, // 'I'
  PARSE_COMPLETE: 0x31, // '1'
  BIND_COMPLETE: 0x32, // '2'
  CLOSE_COMPLETE: 0x33, // '3'
  PORTAL_SUSPENDED: 0x73, // 's'
  PARAMETER_DESCRIPTION: 0x74, // 't'
  COPY_IN_RESPONSE: 0x47, // 'G'
  COPY_OUT_RESPONSE: 0x48, // 'H'
  COPY_BOTH_RESPONSE: 0x57, // 'W'
  COPY_DATA: 0x64, // 'd'
  COPY_DONE: 0x63, // 'c'
  NEGOTIATE_PROTOCOL_VERSION: 0x76, // 'v'
};

// Authentication request codes inside an 'R' message.
const AUTH = {
  OK: 0,
  KERBEROS_V5: 2,
  CLEARTEXT_PASSWORD: 3,
  MD5_PASSWORD: 5,
  SCM_CREDENTIAL: 6,
  GSS: 7,
  GSS_CONTINUE: 8,
  SSPI: 9,
  SASL: 10,
  SASL_CONTINUE: 11,
  SASL_FINAL: 12,
};

const AUTH_NAMES = {
  [AUTH.KERBEROS_V5]: 'Kerberos V5',
  [AUTH.SCM_CREDENTIAL]: 'SCM credential',
  [AUTH.GSS]: 'GSSAPI',
  [AUTH.GSS_CONTINUE]: 'GSSAPI',
  [AUTH.SSPI]: 'SSPI',
};

// Type OIDs (from pg_type) that we convert.
const OID = {
  BOOL: 16,
  BYTEA: 17,
  NAME: 19,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  OID: 26,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
  // array types
  JSON_ARRAY: 199,
  BOOL_ARRAY: 1000,
  BYTEA_ARRAY: 1001,
  NAME_ARRAY: 1003,
  INT2_ARRAY: 1005,
  INT4_ARRAY: 1007,
  TEXT_ARRAY: 1009,
  BPCHAR_ARRAY: 1014,
  VARCHAR_ARRAY: 1015,
  INT8_ARRAY: 1016,
  FLOAT4_ARRAY: 1021,
  FLOAT8_ARRAY: 1022,
  OID_ARRAY: 1028,
  TIMESTAMP_ARRAY: 1115,
  DATE_ARRAY: 1182,
  TIMESTAMPTZ_ARRAY: 1185,
  NUMERIC_ARRAY: 1231,
  UUID_ARRAY: 2951,
  JSONB_ARRAY: 3807,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error reported by the PostgreSQL server (ErrorResponse message). */
class DatabaseError extends Error {
  constructor(fields) {
    super(fields.M || 'Unknown database error');
    this.name = 'DatabaseError';
    this.severity = fields.V || fields.S;
    this.code = fields.C;
    this.detail = fields.D;
    this.hint = fields.H;
    this.position = fields.P;
    this.internalPosition = fields.p;
    this.internalQuery = fields.q;
    this.where = fields.W;
    this.schema = fields.s;
    this.table = fields.t;
    this.column = fields.c;
    this.dataType = fields.d;
    this.constraint = fields.n;
    this.file = fields.F;
    this.line = fields.L;
    this.routine = fields.R;
  }
}

function truncateQueryText(text) {
  if (typeof text !== 'string') return text;
  return text.length > MAX_QUERY_TEXT_IN_ERRORS ? text.slice(0, MAX_QUERY_TEXT_IN_ERRORS) + '…' : text;
}

function connectionLostError(message) {
  const err = new Error(message);
  err.code = 'ECONNCLOSED';
  return err;
}

// FATAL errors with SQLSTATE class 57P (admin_shutdown, crash_shutdown,
// cannot_connect_now, database_dropped, idle_session_timeout) mean the server
// shut this session down on purpose.
function isServerShutdownError(err) {
  return err instanceof DatabaseError && typeof err.code === 'string' && err.code.startsWith('57P');
}

// Adds "where was query() called from" to an error's stack trace, because errors
// created inside socket callbacks otherwise have a useless stack.
function appendCallSite(err, callSiteError) {
  if (!err || typeof err !== 'object' || err.callSiteAdded || !callSiteError.stack) return;
  err.callSiteAdded = true;
  const callerLines = callSiteError.stack.split('\n').slice(1).join('\n');
  err.stack = `${err.stack}\n    --- query called from ---\n${callerLines}`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Invalid connectionString: expected postgres://user:password@host:port/database');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Invalid connectionString protocol "${url.protocol}" (expected postgres:// or postgresql://)`);
  }
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6
  return {
    host: host ? decodeURIComponent(host) : undefined,
    port: url.port ? Number(url.port) : undefined,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: url.pathname && url.pathname !== '/' ? decodeURIComponent(url.pathname.slice(1)) : undefined,
    sslmode: url.searchParams.get('sslmode') || undefined,
    application_name: url.searchParams.get('application_name') || undefined,
  };
}

/**
 * Decides SSL behaviour. Returns { mode: 'disable'|'prefer'|'require', tlsOptions }.
 * The `ssl` option (if given) wins over ?sslmode in the URL.
 */
function resolveSslSettings(sslOption, sslmode) {
  if (sslOption === true) return { mode: 'require', tlsOptions: { rejectUnauthorized: false } };
  if (sslOption === false) return { mode: 'disable', tlsOptions: {} };
  if (sslOption && typeof sslOption === 'object') {
    return { mode: 'require', tlsOptions: { rejectUnauthorized: false, ...sslOption } };
  }
  switch (sslmode) {
    case undefined:
    case 'disable':
    case 'allow': // libpq "allow" = try plain first; plain always works for us
      return { mode: 'disable', tlsOptions: {} };
    case 'prefer':
      return { mode: 'prefer', tlsOptions: { rejectUnauthorized: false } };
    case 'require':
    case 'no-verify':
      return { mode: 'require', tlsOptions: { rejectUnauthorized: false } };
    case 'verify-ca':
    case 'verify-full':
      return { mode: 'require', tlsOptions: { rejectUnauthorized: true } };
    default:
      throw new Error(`Unsupported sslmode "${sslmode}" (use disable, prefer, require, no-verify, verify-ca or verify-full)`);
  }
}

function buildConnectionConfig(options) {
  const fromUrl = options.connectionString ? parseConnectionString(options.connectionString) : {};
  const user = options.user ?? fromUrl.user;
  if (!user) throw new Error('No database user given (set it in connectionString or the `user` option)');
  return {
    host: options.host ?? fromUrl.host ?? 'localhost',
    port: Number(options.port ?? fromUrl.port ?? 5432),
    user,
    password: options.password ?? fromUrl.password,
    database: options.database ?? fromUrl.database ?? user,
    applicationName: options.application_name ?? fromUrl.application_name ?? 'node-pg-lite',
    connectTimeoutMs: options.connectTimeoutMs ?? 10000,
    statementTimeoutMs: options.statementTimeoutMs ?? 0,
    ssl: resolveSslSettings(options.ssl, fromUrl.sslmode),
  };
}

// ---------------------------------------------------------------------------
// Converting JS values to PostgreSQL text format (query parameters)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Converts one JS value to the text PostgreSQL expects, or null for SQL NULL. */
function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString(); // throws RangeError for invalid dates
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
  if (value instanceof Uint8Array) return '\\x' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return serializeArray(value);
  if (typeof value === 'object' && isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

/**
 * Builds a PostgreSQL array literal. Every non-null element is double-quoted,
 * with backslashes and double quotes escaped, which is valid for every
 * element type (numbers included) and makes commas/braces/spaces safe.
 */
function serializeArray(array) {
  const parts = array.map((element) => {
    if (element === null || element === undefined) return 'NULL';
    if (Array.isArray(element)) return serializeArray(element);
    const text = serializeValue(element);
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Converting PostgreSQL text format to JS values (query results)
// ---------------------------------------------------------------------------

function parseText(text) {
  return text;
}

function parseNumber(text) {
  return Number(text);
}

function parseBigInt(text) {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
}

function parseBool(text) {
  return text === 't' || text === 'true';
}

function parseJson(text) {
  return JSON.parse(text);
}

function parseBytea(text) {
  if (text.startsWith('\\x')) return Buffer.from(text.slice(2), 'hex');
  // Legacy "escape" format (bytea_output = escape): \\ is a backslash, \nnn is octal.
  const bytes = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      if (text[i + 1] === '\\') {
        bytes.push(0x5c);
        i += 2;
      } else {
        bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
        i += 4;
      }
    } else {
      bytes.push(text.charCodeAt(i));
      i += 1;
    }
  }
  return Buffer.from(bytes);
}

// Matches DateStyle=ISO output, e.g.
//   2024-03-05 12:34:56.789123+05:30   (timestamptz)
//   2024-03-05 12:34:56                (timestamp)
//   0044-03-15 12:00:00+00 BC
const TIMESTAMP_PATTERN =
  /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( BC)?$/;

function parseTimestamp(text) {
  if (text === 'infinity') return Infinity;
  if (text === '-infinity') return -Infinity;
  const match = TIMESTAMP_PATTERN.exec(text);
  if (!match) return text; // unexpected format: hand back the raw string rather than a wrong Date

  let year = Number(match[1]);
  if (match[12]) year = 1 - year; // 1 BC is year 0 in JS
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const milliseconds = match[7] ? Number(match[7].slice(0, 3).padEnd(3, '0')) : 0;

  const date = new Date(Date.UTC(2000, 0, 1, hours, minutes, seconds, milliseconds));
  date.setUTCFullYear(year, month, day); // setUTCFullYear handles years 0-99 correctly

  if (match[8]) {
    const sign = match[8] === '-' ? -1 : 1;
    const offsetSeconds = Number(match[9]) * 3600 + Number(match[10] || 0) * 60 + Number(match[11] || 0);
    date.setTime(date.getTime() - sign * offsetSeconds * 1000);
  }
  return date;
}

/**
 * Parses a PostgreSQL array literal such as {1,2,NULL}, {"a b","c\"d"} or
 * {{1,2},{3,4}}. `parseElement` converts each non-null element string.
 * Only the comma delimiter is supported (true for all types we map; `box` uses ';').
 */
function parseArray(text, parseElement) {
  let position = 0;

  // Arrays with non-default lower bounds are printed as "[0:2]={1,2,3}".
  if (text[0] === '[') {
    const equalsIndex = text.indexOf('=');
    if (equalsIndex === -1) throw new Error(`Malformed array literal: ${text.slice(0, 50)}`);
    position = equalsIndex + 1;
  }

  function fail() {
    throw new Error(`Malformed array literal at position ${position}: ${text.slice(0, 100)}`);
  }

  function parseLevel() {
    if (text[position] !== '{') fail();
    position += 1;
    const result = [];
    if (text[position] === '}') {
      position += 1;
      return result;
    }
    for (;;) {
      const char = text[position];
      if (char === '{') {
        result.push(parseLevel());
      } else if (char === '"') {
        result.push(parseElement(readQuotedElement()));
      } else {
        const raw = readUnquotedElement();
        result.push(raw.toUpperCase() === 'NULL' ? null : parseElement(raw));
      }
      const separator = text[position];
      position += 1;
      if (separator === ',') continue;
      if (separator === '}') return result;
      fail();
    }
  }

  function readQuotedElement() {
    position += 1; // opening quote
    let value = '';
    let segmentStart = position;
    while (position < text.length) {
      const char = text[position];
      if (char === '\\') {
        value += text.slice(segmentStart, position) + text[position + 1];
        position += 2;
        segmentStart = position;
      } else if (char === '"') {
        value += text.slice(segmentStart, position);
        position += 1; // closing quote
        return value;
      } else {
        position += 1;
      }
    }
    return fail();
  }

  function readUnquotedElement() {
    const start = position;
    while (position < text.length && text[position] !== ',' && text[position] !== '}') position += 1;
    if (position >= text.length) fail();
    return text.slice(start, position);
  }

  const result = parseLevel();
  if (position !== text.length) fail();
  return result;
}

function arrayParser(parseElement) {
  return (text) => parseArray(text, parseElement);
}

const TYPE_PARSERS = new Map([
  [OID.INT2, parseNumber],
  [OID.INT4, parseNumber],
  [OID.OID, parseNumber],
  [OID.INT8, parseBigInt],
  [OID.FLOAT4, parseNumber],
  [OID.FLOAT8, parseNumber],
  [OID.NUMERIC, parseNumber],
  [OID.BOOL, parseBool],
  [OID.JSON, parseJson],
  [OID.JSONB, parseJson],
  [OID.TIMESTAMP, parseTimestamp],
  [OID.TIMESTAMPTZ, parseTimestamp],
  [OID.DATE, parseText],
  [OID.BYTEA, parseBytea],

  [OID.INT2_ARRAY, arrayParser(parseNumber)],
  [OID.INT4_ARRAY, arrayParser(parseNumber)],
  [OID.OID_ARRAY, arrayParser(parseNumber)],
  [OID.INT8_ARRAY, arrayParser(parseBigInt)],
  [OID.FLOAT4_ARRAY, arrayParser(parseNumber)],
  [OID.FLOAT8_ARRAY, arrayParser(parseNumber)],
  [OID.NUMERIC_ARRAY, arrayParser(parseNumber)],
  [OID.BOOL_ARRAY, arrayParser(parseBool)],
  [OID.TEXT_ARRAY, arrayParser(parseText)],
  [OID.VARCHAR_ARRAY, arrayParser(parseText)],
  [OID.BPCHAR_ARRAY, arrayParser(parseText)],
  [OID.NAME_ARRAY, arrayParser(parseText)],
  [OID.UUID_ARRAY, arrayParser(parseText)],
  [OID.JSON_ARRAY, arrayParser(parseJson)],
  [OID.JSONB_ARRAY, arrayParser(parseJson)],
  [OID.TIMESTAMP_ARRAY, arrayParser(parseTimestamp)],
  [OID.TIMESTAMPTZ_ARRAY, arrayParser(parseTimestamp)],
  [OID.DATE_ARRAY, arrayParser(parseText)],
  [OID.BYTEA_ARRAY, arrayParser(parseBytea)],
]);

function getTypeParser(typeOid) {
  return TYPE_PARSERS.get(typeOid) || parseText;
}

// ---------------------------------------------------------------------------
// Building frontend (client -> server) messages
// ---------------------------------------------------------------------------

/** Collects the pieces of one protocol message and produces a Buffer. */
class MessageBuilder {
  constructor(typeChar) {
    this.typeChar = typeChar; // null for the startup / SSL request messages
    this.chunks = [];
    this.length = 0;
  }

  addInt16(value) {
    const buf = Buffer.allocUnsafe(2);
    buf.writeInt16BE(value);
    return this.addBytes(buf);
  }

  addUInt16(value) {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUInt16BE(value);
    return this.addBytes(buf);
  }

  addInt32(value) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32BE(value);
    return this.addBytes(buf);
  }

  addCString(text) {
    if (text.includes('\0')) throw new TypeError('Strings sent to PostgreSQL must not contain NUL (\\0) characters');
    this.addBytes(Buffer.from(text, 'utf8'));
    return this.addBytes(Buffer.from([0]));
  }

  addBytes(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
    return this;
  }

  build() {
    const headerSize = this.typeChar ? 5 : 4;
    const header = Buffer.allocUnsafe(headerSize);
    if (this.typeChar) {
      header.write(this.typeChar, 0, 'latin1');
      header.writeInt32BE(this.length + 4, 1);
    } else {
      header.writeInt32BE(this.length + 4, 0);
    }
    return Buffer.concat([header, ...this.chunks], headerSize + this.length);
  }
}

function buildSslRequest() {
  return new MessageBuilder(null).addInt32(SSL_REQUEST_CODE).build();
}

function buildStartupMessage(parameters) {
  const builder = new MessageBuilder(null).addInt32(PROTOCOL_VERSION_3);
  for (const [name, value] of Object.entries(parameters)) {
    builder.addCString(name).addCString(String(value));
  }
  return builder.addBytes(Buffer.from([0])).build();
}

function buildPasswordMessage(password) {
  return new MessageBuilder('p').addCString(password).build();
}

function buildSaslInitialResponse(mechanism, data) {
  const payload = Buffer.from(data, 'utf8');
  return new MessageBuilder('p').addCString(mechanism).addInt32(payload.length).addBytes(payload).build();
}

function buildSaslResponse(data) {
  return new MessageBuilder('p').addBytes(Buffer.from(data, 'utf8')).build();
}

function buildSimpleQuery(text) {
  return new MessageBuilder('Q').addCString(text).build();
}

function buildCopyFail(reason) {
  return new MessageBuilder('f').addCString(reason).build();
}

function buildTerminate() {
  return new MessageBuilder('X').build();
}

/**
 * Parse + Bind + Describe + Execute + Sync for an unnamed statement/portal,
 * with all parameters and results in text format. Sent as one write.
 */
function buildExtendedQuery(text, values) {
  if (values.length > MAX_PARAMETERS) {
    throw new RangeError(`Too many query parameters (${values.length}); PostgreSQL allows at most ${MAX_PARAMETERS}`);
  }

  const parse = new MessageBuilder('P')
    .addCString('') // unnamed statement
    .addCString(text)
    .addInt16(0) // let the server infer parameter types
    .build();

  const bind = new MessageBuilder('B')
    .addCString('') // unnamed portal
    .addCString('') // unnamed statement
    .addInt16(0) // all parameters use text format
    .addUInt16(values.length);
  for (const value of values) {
    const serialized = serializeValue(value);
    if (serialized === null) {
      bind.addInt32(-1);
    } else {
      const bytes = Buffer.from(serialized, 'utf8');
      bind.addInt32(bytes.length).addBytes(bytes);
    }
  }
  bind.addInt16(0); // all result columns use text format

  const describe = new MessageBuilder('D').addBytes(Buffer.from('P', 'latin1')).addCString('').build();
  const execute = new MessageBuilder('E').addCString('').addInt32(0).build(); // 0 = no row limit
  const sync = new MessageBuilder('S').build();

  return Buffer.concat([parse, bind.build(), describe, execute, sync]);
}

// ---------------------------------------------------------------------------
// Reading backend messages from the socket
// ---------------------------------------------------------------------------

const READER_INITIAL_SIZE = 64 * 1024;
const READER_SHRINK_THRESHOLD = 4 * 1024 * 1024;

/**
 * Accumulates socket chunks in one growable buffer and splits them into
 * complete protocol messages. Handles messages split across chunks and many
 * messages per chunk. The buffer doubles when it needs to grow, so total
 * copying stays linear in the amount of data (no O(n²) concatenation).
 *
 * Usage:  reader.append(chunk); while (reader.next()) use(reader.type, reader.body);
 * `reader.body` is a view into the internal buffer: it is only valid until the
 * next append(), so it must be fully consumed synchronously.
 */
class MessageReader {
  constructor() {
    this.buffer = Buffer.allocUnsafe(READER_INITIAL_SIZE);
    this.readOffset = 0;
    this.writeOffset = 0;
    this.type = 0;
    this.body = null;
  }

  append(chunk) {
    const unread = this.writeOffset - this.readOffset;
    if (unread === 0) {
      this.readOffset = 0;
      this.writeOffset = 0;
      // Give memory back after a huge result, unless this chunk needs it anyway.
      if (this.buffer.length > READER_SHRINK_THRESHOLD && chunk.length < READER_INITIAL_SIZE) {
        this.buffer = Buffer.allocUnsafe(READER_INITIAL_SIZE);
      }
    }
    if (this.writeOffset + chunk.length > this.buffer.length) {
      const needed = unread + chunk.length;
      if (needed <= this.buffer.length / 2) {
        // Enough room if we move the unread bytes to the front.
        this.buffer.copy(this.buffer, 0, this.readOffset, this.writeOffset);
      } else {
        let newSize = this.buffer.length * 2;
        while (newSize < needed * 2) newSize *= 2;
        const bigger = Buffer.allocUnsafe(newSize);
        this.buffer.copy(bigger, 0, this.readOffset, this.writeOffset);
        this.buffer = bigger;
      }
      this.readOffset = 0;
      this.writeOffset = unread;
    }
    chunk.copy(this.buffer, this.writeOffset);
    this.writeOffset += chunk.length;
  }

  /** Moves to the next complete message. Returns false if more data is needed. */
  next() {
    const available = this.writeOffset - this.readOffset;
    if (available < 5) return false;
    const length = this.buffer.readInt32BE(this.readOffset + 1); // includes itself, excludes type byte
    if (length < 4) throw new Error(`Protocol error: invalid message length ${length}`);
    if (available < length + 1) return false;
    this.type = this.buffer[this.readOffset];
    this.body = this.buffer.subarray(this.readOffset + 5, this.readOffset + 1 + length);
    this.readOffset += length + 1;
    return true;
  }
}

/** Reads NUL-terminated strings out of a message body. */
function readCString(body, offset) {
  const end = body.indexOf(0, offset);
  if (end === -1) throw new Error('Protocol error: unterminated string');
  return { value: body.toString('utf8', offset, end), next: end + 1 };
}

function parseErrorFields(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const { value, next } = readCString(body, offset + 1);
    fields[code] = value;
    offset = next;
  }
  return fields;
}

function parseRowDescription(body) {
  const columnCount = body.readUInt16BE(0);
  const fields = new Array(columnCount);
  const names = new Array(columnCount);
  const parsers = new Array(columnCount);
  let offset = 2;
  for (let i = 0; i < columnCount; i++) {
    const { value: name, next } = readCString(body, offset);
    offset = next;
    // tableOID int32, columnNumber int16, typeOID int32, typeSize int16, typeModifier int32, format int16
    const dataTypeID = body.readUInt32BE(offset + 6);
    offset += 18;
    fields[i] = { name, dataTypeID };
    names[i] = name;
    parsers[i] = getTypeParser(dataTypeID);
  }
  return { fields, names, parsers };
}

function parseDataRow(body, names, parsers) {
  const columnCount = body.readUInt16BE(0);
  const row = {};
  let offset = 2;
  for (let i = 0; i < columnCount; i++) {
    const length = body.readInt32BE(offset);
    offset += 4;
    if (length === -1) {
      row[names[i]] = null;
    } else {
      const text = body.toString('utf8', offset, offset + length);
      offset += length;
      try {
        row[names[i]] = parsers[i](text);
      } catch (cause) {
        throw new Error(`Could not parse value of column "${names[i]}": ${cause.message}`, { cause });
      }
    }
  }
  return row;
}

function parseCommandTag(tag) {
  // Examples: "SELECT 5", "INSERT 0 1", "UPDATE 3", "CREATE TABLE", "BEGIN"
  const words = tag.split(' ');
  const last = words[words.length - 1];
  const rowCount = words.length > 1 && /^\d+$/.test(last) ? Number(last) : null;
  return { command: words[0], rowCount };
}

// ---------------------------------------------------------------------------
// Authentication helpers
// ---------------------------------------------------------------------------

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/** "md5" + md5(md5(password + user) + salt), as required by AuthenticationMD5Password. */
function computeMd5Password(user, password, salt) {
  const inner = md5Hex(Buffer.from(password + user, 'utf8'));
  return 'md5' + md5Hex(Buffer.concat([Buffer.from(inner, 'utf8'), salt]));
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function parseScramAttributes(message) {
  const attributes = {};
  for (const part of message.split(',')) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex > 0) attributes[part.slice(0, equalsIndex)] = part.slice(equalsIndex + 1);
  }
  return attributes;
}

/** SCRAM-SHA-256 client (RFC 5802 / RFC 7677) without channel binding. */
class ScramSession {
  constructor(password) {
    this.password = password;
    this.clientNonce = crypto.randomBytes(18).toString('base64');
    // PostgreSQL ignores the SCRAM username (it uses the startup user), so send '*' like other drivers.
    this.clientFirstMessageBare = `n=*,r=${this.clientNonce}`;
    this.expectedServerSignature = null;
  }

  clientFirstMessage() {
    return `n,,${this.clientFirstMessageBare}`; // "n,," = no channel binding
  }

  /** Takes server-first-message, returns client-final-message. */
  clientFinalMessage(serverFirstMessage) {
    const attributes = parseScramAttributes(serverFirstMessage);
    const serverNonce = attributes.r;
    const salt = attributes.s;
    const iterations = Number(attributes.i);
    if (!serverNonce || !serverNonce.startsWith(this.clientNonce) || serverNonce.length === this.clientNonce.length) {
      throw new Error('SCRAM authentication failed: server nonce is invalid');
    }
    if (!salt) throw new Error('SCRAM authentication failed: server did not send a salt');
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new Error('SCRAM authentication failed: invalid iteration count');
    }

    const saltedPassword = crypto.pbkdf2Sync(
      Buffer.from(this.password.normalize('NFKC'), 'utf8'),
      Buffer.from(salt, 'base64'),
      iterations,
      32,
      'sha256',
    );
    const clientKey = hmacSha256(saltedPassword, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`; // biws = base64("n,,")
    const authMessage = `${this.clientFirstMessageBare},${serverFirstMessage},${clientFinalWithoutProof}`;
    const clientSignature = hmacSha256(storedKey, authMessage);
    const clientProof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < clientKey.length; i++) clientProof[i] = clientKey[i] ^ clientSignature[i];

    const serverKey = hmacSha256(saltedPassword, 'Server Key');
    this.expectedServerSignature = hmacSha256(serverKey, authMessage);
    return `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`;
  }

  /** Checks server-final-message: proves the server knows the password too. */
  verifyServerFinalMessage(serverFinalMessage) {
    const attributes = parseScramAttributes(serverFinalMessage);
    if (attributes.e) throw new Error(`SCRAM authentication failed: ${attributes.e}`);
    if (!attributes.v || !this.expectedServerSignature) {
      throw new Error('SCRAM authentication failed: server did not send a signature');
    }
    const serverSignature = Buffer.from(attributes.v, 'base64');
    if (
      serverSignature.length !== this.expectedServerSignature.length ||
      !crypto.timingSafeEqual(serverSignature, this.expectedServerSignature)
    ) {
      throw new Error('SCRAM authentication failed: server signature does not match');
    }
  }
}

// ---------------------------------------------------------------------------
// Connection: one socket to the server
// ---------------------------------------------------------------------------

/**
 * A single connection. Requests are queued and run one at a time.
 *
 * Events:
 *   'end' (err|null) — emitted exactly once when the connection is gone.
 *                      err is null when we closed it ourselves.
 *   'notice' (fields), 'notification' ({ processId, channel, payload })
 * A Connection never emits 'error', so it can never crash the process.
 */
class Connection extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.rawSocket = null; // the TCP socket
    this.socket = null; // the socket we talk on (TCP or TLS)
    this.reader = new MessageReader();
    this.queue = [];
    this.activeRequest = null;
    this.isReady = false;
    this.isDead = false;
    this.isClosing = false;
    this.transactionStatus = 'I'; // I = idle, T = in transaction, E = failed transaction
    this.serverParameters = {};
    this.processId = null;
    this.secretKey = null;
    this.scramSession = null;
    this.startup = null; // { resolve, reject, timer } while connecting
    this.closeTimer = null;
  }

  /** Opens the socket, negotiates SSL, authenticates. Resolves when ready. */
  connect() {
    return new Promise((resolve, reject) => {
      let timer = null;
      const timeoutMs = this.config.connectTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const err = new Error(
            `Timed out after ${timeoutMs} ms connecting to PostgreSQL at ${this.config.host}:${this.config.port}`,
          );
          err.code = 'ETIMEDOUT';
          this.destroy(err);
        }, timeoutMs);
      }
      this.startup = { resolve, reject, timer };
      this.openSocket();
    });
  }

  openSocket() {
    const { host, port, ssl } = this.config;
    const raw = net.connect({ host, port });
    this.rawSocket = raw;
    this.socket = raw;
    raw.setNoDelay(true);
    raw.setKeepAlive(true, 30000);
    raw.on('error', (err) => this.destroy(err));
    raw.on('close', () => this.destroy(connectionLostError('Connection terminated unexpectedly')));
    raw.once('connect', () => {
      if (ssl.mode === 'disable') this.beginStartup(raw);
      else this.requestSsl(raw);
    });
  }

  requestSsl(raw) {
    raw.once('data', (chunk) => {
      if (this.isDead) return;
      if (chunk.length !== 1) {
        // Extra bytes here could be injected by an attacker (CVE-2021-23214), refuse.
        this.destroy(new Error('Protocol error: unexpected data after SSL negotiation response'));
        return;
      }
      const answer = chunk[0];
      if (answer === 0x53 /* 'S' */) {
        this.upgradeToTls(raw);
      } else if (answer === 0x4e /* 'N' */) {
        if (this.config.ssl.mode === 'prefer') {
          this.beginStartup(raw);
        } else {
          this.destroy(new Error('The server does not support SSL connections, but SSL is required (sslmode)'));
        }
      } else {
        this.destroy(new Error('Protocol error: unexpected response to SSL request'));
      }
    });
    raw.write(buildSslRequest());
  }

  upgradeToTls(raw) {
    const tlsOptions = { ...this.config.ssl.tlsOptions, socket: raw };
    if (!net.isIP(this.config.host) && tlsOptions.servername === undefined) {
      tlsOptions.servername = this.config.host; // SNI must not be an IP address
    }
    const secureSocket = tls.connect(tlsOptions);
    this.socket = secureSocket;
    secureSocket.on('error', (err) => this.destroy(err));
    secureSocket.on('close', () => this.destroy(connectionLostError('Connection terminated unexpectedly')));
    secureSocket.once('secureConnect', () => this.beginStartup(secureSocket));
  }

  beginStartup(socket) {
    if (this.isDead) return;
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    const parameters = {
      user: this.config.user,
      database: this.config.database,
      client_encoding: 'UTF8',
      application_name: this.config.applicationName,
      DateStyle: 'ISO',
      // Timestamps without time zone are parsed as UTC, so make the session UTC too.
      // Without this, now()::timestamp or Date -> timestamp casts would depend on the
      // server's configured TimeZone. A query can still `SET TIME ZONE` if needed.
      TimeZone: 'UTC',
    };
    if (this.config.statementTimeoutMs > 0) {
      parameters.statement_timeout = String(this.config.statementTimeoutMs);
    }
    socket.write(buildStartupMessage(parameters));
  }

  onData(chunk) {
    if (this.isDead) return;
    try {
      this.reader.append(chunk);
      while (!this.isDead && this.reader.next()) {
        this.handleMessage(this.reader.type, this.reader.body);
      }
    } catch (err) {
      this.destroy(err);
    }
  }

  handleMessage(type, body) {
    const request = this.activeRequest;
    switch (type) {
      case BACKEND.AUTHENTICATION:
        this.handleAuthentication(body);
        break;
      case BACKEND.PARAMETER_STATUS: {
        const name = readCString(body, 0);
        const value = readCString(body, name.next);
        this.serverParameters[name.value] = value.value;
        break;
      }
      case BACKEND.BACKEND_KEY_DATA:
        this.processId = body.readInt32BE(0);
        this.secretKey = body.readInt32BE(4);
        break;
      case BACKEND.READY_FOR_QUERY:
        this.transactionStatus = String.fromCharCode(body[0]);
        if (!this.isReady) this.finishStartup();
        else this.finishActiveRequest();
        break;
      case BACKEND.ERROR_RESPONSE:
        this.handleServerError(new DatabaseError(parseErrorFields(body)));
        break;
      case BACKEND.NOTICE_RESPONSE:
        if (this.listenerCount('notice') > 0) this.emit('notice', parseErrorFields(body));
        break;
      case BACKEND.NOTIFICATION_RESPONSE: {
        if (this.listenerCount('notification') > 0) {
          const channel = readCString(body, 4);
          const payload = readCString(body, channel.next);
          this.emit('notification', { processId: body.readInt32BE(0), channel: channel.value, payload: payload.value });
        }
        break;
      }
      case BACKEND.ROW_DESCRIPTION:
        if (request) {
          request.receivedResponse = true;
          request.current = { ...parseRowDescription(body), rows: [] };
        }
        break;
      case BACKEND.NO_DATA:
        if (request) request.receivedResponse = true;
        break;
      case BACKEND.DATA_ROW:
        if (request && !request.error) this.handleDataRow(request, body);
        break;
      case BACKEND.COMMAND_COMPLETE:
        if (request) {
          request.receivedResponse = true;
          const { command, rowCount } = parseCommandTag(readCString(body, 0).value);
          const current = request.current || { fields: [], rows: [] };
          request.results.push({ command, rowCount, rows: current.rows, fields: current.fields });
          request.current = null;
        }
        break;
      case BACKEND.EMPTY_QUERY_RESPONSE:
        if (request) {
          request.receivedResponse = true;
          request.results.push({ command: null, rowCount: null, rows: [], fields: [] });
          request.current = null;
        }
        break;
      case BACKEND.PARSE_COMPLETE:
      case BACKEND.BIND_COMPLETE:
      case BACKEND.CLOSE_COMPLETE:
      case BACKEND.PORTAL_SUSPENDED:
      case BACKEND.PARAMETER_DESCRIPTION:
        if (request) request.receivedResponse = true;
        break;
      case BACKEND.COPY_IN_RESPONSE:
        // We cannot supply COPY data; tell the server to abort the COPY (it replies with an error).
        if (request) request.receivedResponse = true;
        this.socket.write(buildCopyFail('COPY FROM STDIN is not supported by this client'));
        break;
      case BACKEND.COPY_OUT_RESPONSE:
      case BACKEND.COPY_DATA:
      case BACKEND.COPY_DONE:
        if (request) request.receivedResponse = true; // COPY TO STDOUT data is discarded
        break;
      case BACKEND.COPY_BOTH_RESPONSE:
        throw new Error('COPY BOTH (replication) is not supported by this client');
      case BACKEND.NEGOTIATE_PROTOCOL_VERSION:
        break; // we request no protocol extensions, so nothing to adjust
      default:
        throw new Error(`Protocol error: unknown message type 0x${type.toString(16)}`);
    }
  }

  handleDataRow(request, body) {
    if (!request.current) {
      request.error = new Error('Protocol error: DataRow received before RowDescription');
      return;
    }
    try {
      request.current.rows.push(parseDataRow(body, request.current.names, request.current.parsers));
    } catch (err) {
      // Keep reading until ReadyForQuery so the connection stays in sync; report the error then.
      request.error = err;
    }
  }

  handleAuthentication(body) {
    const code = body.readInt32BE(0);
    const { user, password } = this.config;
    switch (code) {
      case AUTH.OK:
        return;
      case AUTH.CLEARTEXT_PASSWORD:
        this.requirePassword();
        this.socket.write(buildPasswordMessage(password));
        return;
      case AUTH.MD5_PASSWORD:
        this.requirePassword();
        this.socket.write(buildPasswordMessage(computeMd5Password(user, password, body.subarray(4, 8))));
        return;
      case AUTH.SASL: {
        const mechanisms = [];
        let offset = 4;
        while (offset < body.length && body[offset] !== 0) {
          const mechanism = readCString(body, offset);
          mechanisms.push(mechanism.value);
          offset = mechanism.next;
        }
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          throw new Error(`Unsupported SASL authentication mechanisms: ${mechanisms.join(', ')} (only SCRAM-SHA-256 is supported)`);
        }
        this.requirePassword();
        this.scramSession = new ScramSession(password);
        this.socket.write(buildSaslInitialResponse('SCRAM-SHA-256', this.scramSession.clientFirstMessage()));
        return;
      }
      case AUTH.SASL_CONTINUE: {
        if (!this.scramSession) throw new Error('Protocol error: unexpected SASL continue message');
        const clientFinal = this.scramSession.clientFinalMessage(body.toString('utf8', 4));
        this.socket.write(buildSaslResponse(clientFinal));
        return;
      }
      case AUTH.SASL_FINAL:
        if (!this.scramSession) throw new Error('Protocol error: unexpected SASL final message');
        this.scramSession.verifyServerFinalMessage(body.toString('utf8', 4));
        this.scramSession = null;
        return;
      default: {
        const name = AUTH_NAMES[code] || `code ${code}`;
        throw new Error(
          `Unsupported authentication method requested by the server: ${name}. ` +
            'Supported methods: trust, password, md5, scram-sha-256.',
        );
      }
    }
  }

  requirePassword() {
    if (typeof this.config.password !== 'string' || this.config.password === '') {
      throw new Error('The server requested password authentication, but no password was provided');
    }
  }

  handleServerError(err) {
    if (!this.isReady) {
      // Error during startup: bad password, unknown database, too many connections, ...
      this.destroy(err);
      return;
    }
    if (err.severity === 'FATAL' || err.severity === 'PANIC') {
      // The server is about to close the connection (e.g. pg_terminate_backend, shutdown).
      this.destroy(err);
      return;
    }
    const request = this.activeRequest;
    if (request) {
      request.receivedResponse = true;
      if (!request.error) request.error = err;
    }
  }

  finishStartup() {
    this.isReady = true;
    const { resolve, timer } = this.startup;
    clearTimeout(timer);
    this.startup = null;
    resolve();
    this.sendNextRequest();
  }

  /** Runs one query with the extended protocol. Resolves to { rows, rowCount, command, fields }. */
  query(text, values = []) {
    return this.enqueue('extended', text, () => buildExtendedQuery(text, values));
  }

  /** Runs one or more ;-separated statements with the simple protocol. Resolves to an array of results. */
  simpleQuery(text) {
    return this.enqueue('simple', text, () => buildSimpleQuery(text));
  }

  enqueue(kind, text, buildMessages) {
    return new Promise((resolve, reject) => {
      if (this.isDead || this.isClosing) {
        const err = connectionLostError('Connection is closed');
        err.query = truncateQueryText(text);
        err.retryable = true; // never sent
        reject(err);
        return;
      }
      let messages;
      try {
        messages = buildMessages();
      } catch (err) {
        err.query = truncateQueryText(text);
        reject(err);
        return;
      }
      this.queue.push({
        kind,
        text,
        messages,
        resolve,
        reject,
        results: [],
        current: null,
        error: null,
        receivedResponse: false,
      });
      this.sendNextRequest();
    });
  }

  sendNextRequest() {
    if (!this.isReady || this.isDead || this.activeRequest || this.queue.length === 0) return;
    const request = this.queue.shift();
    this.activeRequest = request;
    const messages = request.messages;
    request.messages = null; // free memory early (big parameters)
    this.socket.write(messages);
  }

  finishActiveRequest() {
    const request = this.activeRequest;
    this.activeRequest = null;
    if (request) {
      if (request.error) {
        request.error.query = truncateQueryText(request.text);
        request.reject(request.error);
      } else if (request.kind === 'simple') {
        request.resolve(request.results);
      } else {
        request.resolve(request.results[0] || { command: null, rowCount: null, rows: [], fields: [] });
      }
    }
    this.sendNextRequest();
  }

  /** Graceful close: sends Terminate and ends the socket. Resolves when closed. */
  close() {
    if (this.isDead) return Promise.resolve();
    const closed = new Promise((resolve) => this.once('end', () => resolve()));
    if (!this.isClosing) {
      this.isClosing = true;
      if (!this.isReady || !this.socket) {
        this.destroy(null);
      } else {
        try {
          this.socket.write(buildTerminate());
          this.socket.end();
        } catch {
          this.destroy(null);
        }
        // If the server never closes its side, force it.
        this.closeTimer = setTimeout(() => this.destroy(null), 3000);
        this.closeTimer.unref();
      }
    }
    return closed;
  }

  /**
   * Tears the connection down immediately. Rejects all pending requests and
   * emits 'end' exactly once. Safe to call many times.
   */
  destroy(err) {
    if (this.isDead) return;
    this.isDead = true;
    clearTimeout(this.closeTimer);
    if (this.socket) this.socket.destroy();
    if (this.rawSocket && this.rawSocket !== this.socket) this.rawSocket.destroy();

    const closedByUs = this.isClosing;
    const reason = err || connectionLostError('Connection was closed by the client');

    if (this.startup) {
      clearTimeout(this.startup.timer);
      const { reject } = this.startup;
      this.startup = null;
      reject(reason);
    }

    const active = this.activeRequest;
    const queued = this.queue;
    this.activeRequest = null;
    this.queue = [];

    if (active) {
      reason.query = truncateQueryText(active.text);
      // Safe to retry only if the server shut the session down before it saw our statement.
      reason.retryable = !active.receivedResponse && isServerShutdownError(reason);
      active.reject(reason);
    }
    for (const request of queued) {
      const notSent = connectionLostError(`Connection lost before the query was sent: ${reason.message}`);
      notSent.cause = reason;
      notSent.query = truncateQueryText(request.text);
      notSent.retryable = true;
      request.reject(notSent);
    }

    // After close() the socket 'close' event also lands here; that is a normal shutdown.
    this.emit('end', closedByUs ? null : reason);
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

function validateQueryArguments(text, values) {
  if (typeof text !== 'string') throw new TypeError('Query text must be a string');
  if (values !== undefined && !Array.isArray(values)) throw new TypeError('Query values must be an array');
}

/** A connection borrowed from the pool. Call release() when done. */
class PoolClient {
  constructor(pool, connection) {
    this.pool = pool;
    this.connection = connection;
    this.released = false;
  }

  get processId() {
    return this.connection.processId;
  }

  async query(text, values) {
    validateQueryArguments(text, values);
    this.assertNotReleased();
    const callSite = new Error();
    try {
      return await this.connection.query(text, values || []);
    } catch (err) {
      appendCallSite(err, callSite);
      throw err;
    }
  }

  async simple(text) {
    validateQueryArguments(text, undefined);
    this.assertNotReleased();
    const callSite = new Error();
    try {
      return await this.connection.simpleQuery(text);
    } catch (err) {
      appendCallSite(err, callSite);
      throw err;
    }
  }

  /** Returns the connection to the pool. Pass `true` (or an Error) to destroy it instead. */
  release(destroy) {
    if (this.released) return; // double release is a harmless no-op
    this.released = true;
    this.pool.releaseConnection(this.connection, Boolean(destroy));
  }

  assertNotReleased() {
    if (this.released) throw new Error('This client has already been released back to the pool');
  }
}

class Pool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = buildConnectionConfig(options);
    this.max = options.max ?? 10;
    if (!Number.isInteger(this.max) || this.max < 1) throw new Error('Pool option `max` must be an integer >= 1');
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30000;

    this.connections = new Set(); // every open connection (idle or borrowed)
    this.idleConnections = []; // connections ready to be borrowed (most recently used last)
    this.idleTimers = new Map(); // connection -> idle timeout timer
    this.waiters = []; // FIFO queue of { resolve, reject } waiting for a connection
    this.connectingCount = 0;
    this.isEnded = false;
    this.endPromise = null;
    this.resolveEnd = null;
  }

  // ----- public API -----

  async query(text, values) {
    validateQueryArguments(text, values);
    const callSite = new Error();
    for (let attempt = 1; ; attempt++) {
      const connection = await this.acquireConnection();
      try {
        return await connection.query(text, values || []);
      } catch (err) {
        // Retry once on a new connection if the server never saw this query.
        if (attempt === 1 && err.retryable && !this.isEnded) continue;
        appendCallSite(err, callSite);
        throw err;
      } finally {
        this.releaseConnection(connection, false);
      }
    }
  }

  async simple(text) {
    validateQueryArguments(text, undefined);
    const client = await this.connect();
    try {
      return await client.simple(text);
    } finally {
      client.release();
    }
  }

  async tx(callback) {
    if (typeof callback !== 'function') throw new TypeError('pool.tx expects an async function (client) => {...}');
    const client = await this.connect();
    let destroyConnection = false;
    try {
      await client.query('BEGIN');
      let result;
      try {
        result = await callback(client);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyConnection = true; // state unknown: never reuse this connection
        }
        throw err;
      }
      await client.query('COMMIT');
      return result;
    } finally {
      // releaseConnection also destroys the connection if it is still inside a transaction.
      client.release(destroyConnection);
    }
  }

  async connect() {
    const connection = await this.acquireConnection();
    return new PoolClient(this, connection);
  }

  stats() {
    return {
      total: this.connections.size + this.connectingCount,
      idle: this.idleConnections.length,
      waiting: this.waiters.length,
    };
  }

  /** Closes all connections. Borrowed clients are closed when released. */
  end() {
    if (this.endPromise) return this.endPromise;
    this.isEnded = true;
    this.endPromise = new Promise((resolve) => {
      this.resolveEnd = resolve;
    });
    for (const waiter of this.waiters) waiter.reject(new Error('The pool has been ended'));
    this.waiters = [];
    const idle = this.idleConnections;
    this.idleConnections = [];
    for (const connection of idle) {
      clearTimeout(this.idleTimers.get(connection));
      this.idleTimers.delete(connection);
      connection.close();
    }
    this.checkEndComplete();
    return this.endPromise;
  }

  // ----- internals -----

  acquireConnection() {
    if (this.isEnded) return Promise.reject(new Error('The pool has been ended'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.dispatch();
    });
  }

  /** Hands idle connections to waiters, and opens new connections if allowed. */
  dispatch() {
    if (this.isEnded) return;
    while (this.waiters.length > 0 && this.idleConnections.length > 0) {
      const connection = this.takeIdleConnection();
      if (connection.isDead) continue;
      this.waiters.shift().resolve(connection);
    }
    while (this.waiters.length > this.connectingCount && this.connections.size + this.connectingCount < this.max) {
      this.openConnection();
    }
  }

  openConnection() {
    this.connectingCount++;
    const connection = new Connection(this.config);
    connection.on('end', (err) => this.onConnectionEnd(connection, err));
    connection.connect().then(
      () => {
        this.connectingCount--;
        if (connection.isDead) {
          this.dispatch();
          return;
        }
        this.connections.add(connection);
        if (this.isEnded) {
          connection.close();
          return;
        }
        this.addIdleConnection(connection);
        this.dispatch();
      },
      (err) => {
        this.connectingCount--;
        // Each failed attempt fails the longest-waiting caller (it was opened for them).
        const waiter = this.waiters.shift();
        if (waiter) waiter.reject(err);
        this.checkEndComplete();
        this.dispatch();
      },
    );
  }

  takeIdleConnection() {
    const connection = this.idleConnections.pop(); // most recently used: warm, and lets others time out
    clearTimeout(this.idleTimers.get(connection));
    this.idleTimers.delete(connection);
    return connection;
  }

  addIdleConnection(connection) {
    this.idleConnections.push(connection);
    if (this.idleTimeoutMs > 0) {
      const timer = setTimeout(() => {
        const index = this.idleConnections.indexOf(connection);
        if (index !== -1) this.idleConnections.splice(index, 1);
        this.idleTimers.delete(connection);
        connection.close();
      }, this.idleTimeoutMs);
      timer.unref();
      this.idleTimers.set(connection, timer);
    }
  }

  releaseConnection(connection, destroy) {
    if (connection.isDead) {
      this.dispatch(); // it was already removed by onConnectionEnd
      return;
    }
    const isBusy = connection.activeRequest !== null || connection.queue.length > 0;
    if (destroy || this.isEnded || isBusy || connection.transactionStatus !== 'I') {
      // Never reuse a connection in an unknown state (e.g. released mid-transaction).
      connection.close();
      return;
    }
    this.addIdleConnection(connection);
    this.dispatch();
  }

  onConnectionEnd(connection, err) {
    const wasOpen = this.connections.delete(connection);
    const idleIndex = this.idleConnections.indexOf(connection);
    if (idleIndex !== -1) {
      this.idleConnections.splice(idleIndex, 1);
      clearTimeout(this.idleTimers.get(connection));
      this.idleTimers.delete(connection);
      if (err) this.reportIdleError(err);
    }
    if (wasOpen) {
      this.checkEndComplete();
      this.dispatch(); // capacity freed: waiters may get a new connection
    }
  }

  reportIdleError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.error(`[pg] idle connection error (connection discarded): ${err.message}`);
    }
  }

  checkEndComplete() {
    if (this.isEnded && this.resolveEnd && this.connections.size === 0 && this.connectingCount === 0) {
      const resolve = this.resolveEnd;
      this.resolveEnd = null;
      resolve();
    }
  }
}

function createPool(options) {
  return new Pool(options);
}

module.exports = {
  createPool,
  Pool,
  DatabaseError,
  // Exposed for unit tests; not part of the public API.
  _internal: {
    parseConnectionString,
    buildConnectionConfig,
    serializeValue,
    serializeArray,
    parseArray,
    parseTimestamp,
    parseBytea,
    parseBigInt,
    MessageReader,
    computeMd5Password,
    Connection,
  },
};
