'use strict';

// Integration tests for server/lib/pg.js against a real, throwaway PostgreSQL 16.
// Run: node --test test/pg.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createPool, DatabaseError, _internal } = require('../server/lib/pg');
const { startPgServer } = require('./helpers/pgserver');

let server;
let pool; // shared pool for most tests

before(async () => {
  server = await startPgServer({ ssl: true });
  pool = createPool({ connectionString: server.url, max: 5, application_name: 'castvoo-test' });
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (server) await server.stop();
  }
});

/** Creates a pool and guarantees it is ended after `fn`, even if fn throws. */
async function withPool(options, fn) {
  const testPool = createPool(options);
  testPool.on('error', () => {}); // idle errors are expected in some tests
  try {
    return await fn(testPool);
  } finally {
    await testPool.end();
  }
}

async function one(sql, values) {
  const { rows } = await pool.query(sql, values);
  return rows[0];
}

// ---------------------------------------------------------------------------
describe('unit: connection string and config', () => {
  it('decodes user/password, defaults port and database', () => {
    const parsed = _internal.parseConnectionString('postgres://us%40er:p%40ss%3Aw%2Frd@db.example.com/my%20db?sslmode=require');
    assert.equal(parsed.user, 'us@er');
    assert.equal(parsed.password, 'p@ss:w/rd');
    assert.equal(parsed.host, 'db.example.com');
    assert.equal(parsed.port, undefined);
    assert.equal(parsed.database, 'my db');
    assert.equal(parsed.sslmode, 'require');

    const config = _internal.buildConnectionConfig({ connectionString: 'postgresql://bob@[::1]' });
    assert.equal(config.port, 5432);
    assert.equal(config.host, '::1');
    assert.equal(config.database, 'bob');
    assert.equal(config.ssl.mode, 'disable');
  });

  it('maps sslmode values and lets the ssl option override', () => {
    const mode = (url, ssl) => _internal.buildConnectionConfig({ connectionString: url, ssl }).ssl;
    assert.equal(mode('postgres://u@h/d?sslmode=prefer').mode, 'prefer');
    assert.equal(mode('postgres://u@h/d?sslmode=no-verify').mode, 'require');
    assert.equal(mode('postgres://u@h/d?sslmode=require').tlsOptions.rejectUnauthorized, false);
    assert.equal(mode('postgres://u@h/d?sslmode=verify-full').tlsOptions.rejectUnauthorized, true);
    assert.equal(mode('postgres://u@h/d?sslmode=require', false).mode, 'disable');
    assert.equal(mode('postgres://u@h/d?sslmode=disable', true).mode, 'require');
    assert.throws(() => mode('postgres://u@h/d?sslmode=bogus'), /Unsupported sslmode/);
  });
});

describe('unit: arrays, timestamps, reader', () => {
  it('serializes nested arrays with quoting and nulls', () => {
    assert.equal(_internal.serializeValue([1, 2, 3]), '{"1","2","3"}');
    assert.equal(_internal.serializeValue([]), '{}');
    assert.equal(_internal.serializeValue([[1, null], [undefined, 4]]), '{{"1",NULL},{NULL,"4"}}');
    assert.equal(_internal.serializeValue(['a"b', 'c\\d', 'e,f', '{g}', 'NULL']), '{"a\\"b","c\\\\d","e,f","{g}","NULL"}');
  });

  it('parses array literals', () => {
    const id = (s) => s;
    assert.deepEqual(_internal.parseArray('{}', id), []);
    assert.deepEqual(_internal.parseArray('{a,NULL,"NULL","x\\"y","b\\\\c","d,e"}', id), ['a', null, 'NULL', 'x"y', 'b\\c', 'd,e']);
    assert.deepEqual(_internal.parseArray('{{1,2},{3,NULL}}', Number), [[1, 2], [3, null]]);
    assert.deepEqual(_internal.parseArray('[0:1]={7,8}', Number), [7, 8]);
    assert.throws(() => _internal.parseArray('{1,2', Number), /Malformed/);
  });

  it('parses timestamps in ISO DateStyle', () => {
    assert.equal(_internal.parseTimestamp('2024-03-05 12:34:56.789123+05:30').toISOString(), '2024-03-05T07:04:56.789Z');
    assert.equal(_internal.parseTimestamp('2024-03-05 12:34:56').toISOString(), '2024-03-05T12:34:56.000Z');
    assert.equal(_internal.parseTimestamp('2024-03-05 12:34:56.5-08').toISOString(), '2024-03-05T20:34:56.500Z');
    assert.equal(_internal.parseTimestamp('0010-01-01 00:00:00+00').getUTCFullYear(), 10);
    assert.equal(_internal.parseTimestamp('0044-03-15 00:00:00+00 BC').getUTCFullYear(), -43);
    assert.equal(_internal.parseTimestamp('infinity'), Infinity);
    assert.equal(_internal.parseTimestamp('-infinity'), -Infinity);
  });

  it('MessageReader handles byte-by-byte delivery and many messages per chunk', () => {
    const makeMessage = (type, payload) => {
      const header = Buffer.alloc(5);
      header.write(type, 0, 'latin1');
      header.writeInt32BE(payload.length + 4, 1);
      return Buffer.concat([header, payload]);
    };
    const big = Buffer.alloc(200 * 1024, 7);
    const stream = Buffer.concat([makeMessage('A', Buffer.from('hello')), makeMessage('B', big), makeMessage('C', Buffer.alloc(0))]);

    for (const chunkSize of [1, 3, 1000, stream.length]) {
      const reader = new _internal.MessageReader();
      const seen = [];
      for (let i = 0; i < stream.length; i += chunkSize) {
        reader.append(stream.subarray(i, i + chunkSize));
        while (reader.next()) seen.push([String.fromCharCode(reader.type), reader.body.length, reader.body[0]]);
      }
      assert.deepEqual(seen, [['A', 5, 104], ['B', big.length, 7], ['C', 0, undefined]], `chunk size ${chunkSize}`);
    }
  });

  it('computes md5 passwords like libpq', () => {
    // md5(md5("secret" + "user") + salt) with salt 01020304
    assert.match(_internal.computeMd5Password('user', 'secret', Buffer.from([1, 2, 3, 4])), /^md5[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
describe('authentication', () => {
  before(async () => {
    await pool.simple(`
      SET password_encryption = 'md5';
      CREATE ROLE md5user LOGIN PASSWORD 'md5 p@ss''word';
      SET password_encryption = 'scram-sha-256';
      CREATE ROLE clearuser LOGIN PASSWORD 'clear p@ss';
      CREATE ROLE trustuser LOGIN;
      RESET password_encryption;
    `);
  });

  it('SCRAM-SHA-256 with a password that needs URL encoding', async () => {
    const row = await one('select current_user as u');
    assert.equal(row.u, 'castvoo');
  });

  it('SCRAM-SHA-256 rejects a wrong password with 28P01', async () => {
    await withPool({ connectionString: server.urlFor({ password: 'wrong' }) }, async (p) => {
      await assert.rejects(p.query('select 1'), (err) => err instanceof DatabaseError && err.code === '28P01');
    });
  });

  it('MD5', async () => {
    const stored = await one(`select rolpassword from pg_authid where rolname = 'md5user'`);
    assert.match(stored.rolpassword, /^md5/);
    await withPool({ connectionString: server.urlFor({ user: 'md5user', password: "md5 p@ss'word" }) }, async (p) => {
      assert.equal((await p.query('select current_user as u')).rows[0].u, 'md5user');
    });
    await withPool({ connectionString: server.urlFor({ user: 'md5user', password: 'nope' }) }, async (p) => {
      await assert.rejects(p.query('select 1'), { code: '28P01' });
    });
  });

  it('cleartext password', async () => {
    await withPool({ connectionString: server.urlFor({ user: 'clearuser', password: 'clear p@ss' }) }, async (p) => {
      assert.equal((await p.query('select current_user as u')).rows[0].u, 'clearuser');
    });
  });

  it('trust (no password)', async () => {
    await withPool({ connectionString: server.urlFor({ user: 'trustuser', password: null }) }, async (p) => {
      assert.equal((await p.query('select current_user as u')).rows[0].u, 'trustuser');
    });
  });

  it('clear error when a password is required but missing', async () => {
    await withPool({ connectionString: server.urlFor({ password: null }) }, async (p) => {
      await assert.rejects(p.query('select 1'), /no password was provided/);
    });
  });

  it('startup errors such as an unknown database surface as DatabaseError', async () => {
    await withPool({ connectionString: server.urlFor({ database: 'nope_db' }) }, async (p) => {
      await assert.rejects(p.query('select 1'), { code: '3D000' });
    });
  });
});

// ---------------------------------------------------------------------------
describe('SSL', () => {
  const sslQuery = 'select ssl from pg_stat_ssl where pid = pg_backend_pid()';

  async function usesSsl(options) {
    return withPool(options, async (p) => (await p.query(sslQuery)).rows[0].ssl);
  }

  it('sslmode=require uses SSL', async (t) => {
    if (!server.sslEnabled) return t.skip('openssl not available');
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'require' }) }), true);
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'no-verify' }) }), true);
  });

  it('sslmode=disable uses plain TCP; ssl option overrides sslmode', async (t) => {
    if (!server.sslEnabled) return t.skip('openssl not available');
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'disable' }) }), false);
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'disable' }), ssl: true }), true);
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'require' }), ssl: false }), false);
  });

  it('sslmode=prefer uses SSL when available', async (t) => {
    if (!server.sslEnabled) return t.skip('openssl not available');
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'prefer' }) }), true);
  });

  it('verify-full fails against a self-signed certificate', async (t) => {
    if (!server.sslEnabled) return t.skip('openssl not available');
    await withPool({ connectionString: server.urlFor({ sslmode: 'verify-full' }) }, async (p) => {
      await assert.rejects(p.query('select 1'), /self[- ]signed|certificate/i);
    });
  });

  it('with SSL turned off on the server: require fails clearly, prefer falls back', async (t) => {
    if (!server.sslEnabled) return t.skip('openssl not available');
    await pool.query('alter system set ssl = off');
    await pool.query('select pg_reload_conf()');
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // let the postmaster reload
      await withPool({ connectionString: server.urlFor({ sslmode: 'require' }) }, async (p) => {
        await assert.rejects(p.query('select 1'), /does not support SSL/);
      });
      assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'prefer' }) }), false);
    } finally {
      await pool.query('alter system reset ssl');
      await pool.query('select pg_reload_conf()');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(await usesSsl({ connectionString: server.urlFor({ sslmode: 'require' }) }), true);
  });
});

// ---------------------------------------------------------------------------
describe('result types (server -> JS)', () => {
  it('integers, oid and int8 boundaries', async () => {
    const row = await one(`select 12::int2 as a, (-2147483648)::int4 as b, 26::oid as c,
      9007199254740991::int8 as safe, (-9007199254740991)::int8 as neg_safe,
      9007199254740993::int8 as big, (-9223372036854775808)::int8 as min, count(*) as cnt from (values (1),(2)) v(x)`);
    assert.deepEqual(row, {
      a: 12, b: -2147483648, c: 26,
      safe: 9007199254740991, neg_safe: -9007199254740991,
      big: '9007199254740993', min: '-9223372036854775808', cnt: 2,
    });
  });

  it('floats and numeric', async () => {
    const row = await one(`select 1.5::float4 as f4, 3.141592653589793::float8 as f8, 'NaN'::float8 as nan,
      '-Infinity'::float8 as ninf, 123.456::numeric as num, -0.001::numeric(10,3) as small`);
    assert.equal(row.f4, 1.5);
    assert.equal(row.f8, 3.141592653589793);
    assert.ok(Number.isNaN(row.nan));
    assert.equal(row.ninf, -Infinity);
    assert.equal(row.num, 123.456);
    assert.equal(row.small, -0.001);
  });

  it('bool, json, jsonb', async () => {
    const row = await one(`select true as t, false as f, '{"a":[1,{"b":null}]}'::json as j,
      '{"z":"é","n":1.5,"arr":[true]}'::jsonb as jb, '[1,2]'::jsonb as jarr, 'null'::jsonb as jnull`);
    assert.deepEqual(row, { t: true, f: false, j: { a: [1, { b: null }] }, jb: { z: 'é', n: 1.5, arr: [true] }, jarr: [1, 2], jnull: null });
  });

  it('timestamptz, timestamp, date, infinity', async () => {
    const row = await one(`select '2024-03-05 12:34:56.789+02'::timestamptz as tz, '2024-03-05 12:34:56.789'::timestamp as ts,
      '2024-02-29'::date as d, 'infinity'::timestamptz as inf, '-infinity'::timestamp as ninf`);
    assert.ok(row.tz instanceof Date);
    assert.equal(row.tz.toISOString(), '2024-03-05T10:34:56.789Z');
    assert.equal(row.ts.toISOString(), '2024-03-05T12:34:56.789Z');
    assert.equal(row.d, '2024-02-29');
    assert.equal(row.inf, Infinity);
    assert.equal(row.ninf, -Infinity);
  });

  it('timestamptz is correct regardless of the session time zone', async () => {
    const client = await pool.connect();
    try {
      await client.query(`set time zone 'Asia/Kolkata'`);
      const { rows } = await client.query(`select '2024-01-01 00:00:00+00'::timestamptz as t`);
      assert.equal(rows[0].t.toISOString(), '2024-01-01T00:00:00.000Z');
    } finally {
      await client.query('reset time zone');
      client.release();
    }
  });

  it('bytea (hex and escape output)', async () => {
    const row = await one(`select '\\xdeadbeef00'::bytea as b, ''::bytea as empty`);
    assert.deepEqual(row.b, Buffer.from('deadbeef00', 'hex'));
    assert.deepEqual(row.empty, Buffer.alloc(0));
    assert.deepEqual(_internal.parseBytea('a\\\\b\\000\\377'), Buffer.from([0x61, 0x5c, 0x62, 0, 255]));
  });

  it('string-like and unknown types stay strings', async () => {
    const row = await one(`select 'hi'::text as t, 'v'::varchar(5) as v, 'ab'::char(4) as c,
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as u, 'nm'::name as n, '1 day'::interval as i, '10.0.0.1'::inet as ip`);
    assert.deepEqual(row, { t: 'hi', v: 'v', c: 'ab  ', u: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', n: 'nm', i: '1 day', ip: '10.0.0.1' });
  });

  it('citext (if the extension is installed)', async (t) => {
    try {
      await pool.query('create extension if not exists citext');
    } catch {
      return t.skip('citext extension not available');
    }
    const row = await one(`select 'MiXeD'::citext as c, 'MiXeD'::citext = 'mixed' as eq`);
    assert.deepEqual(row, { c: 'MiXeD', eq: true });
  });

  it('NULL of every type is null', async () => {
    const types = ['int2', 'int4', 'int8', 'oid', 'float4', 'float8', 'numeric', 'bool', 'json', 'jsonb', 'timestamptz',
      'timestamp', 'date', 'bytea', 'text', 'varchar', 'bpchar', 'uuid', 'name', 'int4[]', 'text[]', 'jsonb[]'];
    const sql = 'select ' + types.map((type, i) => `null::${type} as c${i}`).join(', ');
    const row = await one(sql);
    for (let i = 0; i < types.length; i++) assert.equal(row[`c${i}`], null, types[i]);
  });

  it('arrays of every mapped element type', async () => {
    const row = await one(`select
      '{1,2,NULL}'::int2[] as i2, '{1,-2}'::int4[] as i4, '{1,9007199254740993}'::int8[] as i8,
      '{"a b","c\\"d","e\\\\f",NULL,"NULL",""}'::text[] as t, '{x,y}'::varchar[] as vc,
      '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}'::uuid[] as u, '{t,f,NULL}'::bool[] as b,
      '{1.5,NaN,-Infinity}'::float8[] as f8, '{1.25,-3}'::numeric[] as num,
      array['{"a":1}'::jsonb, '[1,"x"]'::jsonb, null] as jb,
      array['2024-01-01 00:00:00+00'::timestamptz, null] as tz,
      '{{1,2},{3,4}}'::int4[] as nested, '{}'::int4[] as empty, '{"{x}",","}'::text[] as punct`);
    assert.deepEqual(row.i2, [1, 2, null]);
    assert.deepEqual(row.i4, [1, -2]);
    assert.deepEqual(row.i8, [1, '9007199254740993']);
    assert.deepEqual(row.t, ['a b', 'c"d', 'e\\f', null, 'NULL', '']);
    assert.deepEqual(row.vc, ['x', 'y']);
    assert.deepEqual(row.u, ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']);
    assert.deepEqual(row.b, [true, false, null]);
    assert.equal(row.f8[0], 1.5);
    assert.ok(Number.isNaN(row.f8[1]));
    assert.equal(row.f8[2], -Infinity);
    assert.deepEqual(row.num, [1.25, -3]);
    assert.deepEqual(row.jb, [{ a: 1 }, [1, 'x'], null]);
    assert.equal(row.tz[0].toISOString(), '2024-01-01T00:00:00.000Z');
    assert.equal(row.tz[1], null);
    assert.deepEqual(row.nested, [[1, 2], [3, 4]]);
    assert.deepEqual(row.empty, []);
    assert.deepEqual(row.punct, ['{x}', ',']);
  });
});

// ---------------------------------------------------------------------------
describe('parameters (JS -> server)', () => {
  it('null, undefined, booleans, numbers, bigint', async () => {
    const row = await one(
      `select $1::int is null as a, $2::text is null as b, $3::bool as t, $4::bool as f, $5::int as n,
        $6::float8 as fl, $7::int8 as big, $8::int8 as huge, pg_typeof($9::numeric)::text as ty`,
      [null, undefined, true, false, -42, 2.5, 123n, 2n ** 62n, 1.5],
    );
    assert.deepEqual(row, { a: true, b: true, t: true, f: false, n: -42, fl: 2.5, big: 123, huge: String(2n ** 62n), ty: 'numeric' });
  });

  it('Date round trips through timestamptz and timestamp', async () => {
    const date = new Date('2023-07-08T09:10:11.123Z');
    const row = await one(`select $1::timestamptz as tz, $2::timestamp as ts, $3::date as d, current_setting('TimeZone') = 'UTC' as utc`,
      [date, date, date]);
    assert.equal(row.utc, true, 'sessions run in UTC');
    assert.equal(row.tz.getTime(), date.getTime());
    assert.equal(row.ts.getTime(), date.getTime());
    assert.equal(row.d, '2023-07-08');
  });

  it('strings with unicode, emoji, quotes, backslashes', async () => {
    const values = ["it's \"quoted\"", 'back\\slash \\x00 \\\\', 'emoji 🚀👩🏽‍💻 ñ 中文 العربية', "'); drop table x; --", '', ' ', '\n\t\r'];
    for (const value of values) {
      const row = await one('select $1::text as v, length($1::text) as len', [value]);
      assert.equal(row.v, value);
      assert.equal(row.len, [...value].length);
    }
  });

  it('a NUL character in query text is rejected client-side', async () => {
    await assert.rejects(pool.query('select 1\0'), /NUL/);
    assert.equal((await one('select 1 as ok')).ok, 1);
  });

  it('Buffer round trips through bytea', async () => {
    const buffer = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const row = await one('select $1::bytea as b, length($1::bytea) as len', [buffer]);
    assert.deepEqual(row.b, buffer);
    assert.equal(row.len, 256);
    assert.deepEqual((await one('select $1::bytea as b', [new Uint8Array([1, 2])])).b, Buffer.from([1, 2]));
  });

  it('plain objects are sent as JSON; nested jsonb round trip', async () => {
    const doc = { name: 'Zé "q" \\ 🚀', nested: { list: [1, 'two', { three: [3, null] }], flag: true, n: null }, empty: {} };
    await pool.query('create temp table if not exists docs (id serial primary key, body jsonb)');
    const client = await pool.connect(); // temp tables are per-connection
    try {
      await client.query('create temp table docs2 (id serial primary key, body jsonb)');
      const { rows } = await client.query('insert into docs2 (body) values ($1) returning body', [doc]);
      assert.deepEqual(rows[0].body, doc);
      const selected = await client.query(`select body->'nested'->'list'->2 as third from docs2`);
      assert.deepEqual(selected.rows[0].third, { three: [3, null] });
      await client.query('drop table docs2');
    } finally {
      client.release();
    }
    const row = await one('select $1::jsonb as j', [JSON.stringify([1, 2, { a: 'b' }])]);
    assert.deepEqual(row.j, [1, 2, { a: 'b' }]);
  });

  it('arrays: = ANY($1) for int and text', async () => {
    const ints = await pool.query('select x from generate_series(1, 10) x where x = any($1::int[]) order by x', [[2, 5, 99]]);
    assert.deepEqual(ints.rows.map((r) => r.x), [2, 5]);
    const texts = await pool.query(
      `select v from unnest(array['a', 'b"c', 'd,e', 'f\\g', 'NULL']) v where v = any($1::text[]) order by v`,
      [['b"c', 'd,e', 'f\\g', 'NULL', 'zzz']],
    );
    assert.deepEqual(texts.rows.map((r) => r.v).sort(), ['NULL', 'b"c', 'd,e', 'f\\g'].sort());
    const none = await pool.query('select 1 from generate_series(1,3) x where x = any($1::int[])', [[]]);
    assert.equal(none.rowCount, 0);
  });

  it('arrays: nested, nulls, special strings, bool, uuid, bytea round trip', async () => {
    const texts = ['plain', 'with space', 'quote"', 'back\\slash', 'comma,', '{brace}', 'NULL', '', null, '🚀'];
    const row = await one(
      'select $1::text[] as t, $2::int[] as nested, $3::bool[] as b, $4::uuid[] as u, $5::bytea[] as by, $6::timestamptz[] as d',
      [texts, [[1, 2], [3, null]], [true, false, null], ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
        [Buffer.from([1, 2]), null], [new Date('2020-01-01T00:00:00Z')]],
    );
    assert.deepEqual(row.t, texts);
    assert.deepEqual(row.nested, [[1, 2], [3, null]]);
    assert.deepEqual(row.b, [true, false, null]);
    assert.deepEqual(row.u, ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']);
    assert.deepEqual(row.by, [Buffer.from([1, 2]), null]);
    assert.equal(row.d[0].toISOString(), '2020-01-01T00:00:00.000Z');
  });

  it('other values use String(value)', async () => {
    class Money { toString() { return '12.50'; } }
    assert.equal((await one('select $1::numeric as m', [new Money()])).m, 12.5);
  });

  it('rejects non-array values argument', async () => {
    await assert.rejects(pool.query('select $1', 'x'), TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('queries and results', () => {
  it('returns rowCount and command for DML', async () => {
    const client = await pool.connect();
    try {
      await client.query('create temp table t1 (id int primary key, v text)');
      const ins = await client.query('insert into t1 values (1,$1),(2,$2)', ['a', 'b']);
      assert.equal(ins.command, 'INSERT');
      assert.equal(ins.rowCount, 2);
      const upd = await client.query('update t1 set v = v || $1', ['!']);
      assert.deepEqual([upd.command, upd.rowCount], ['UPDATE', 2]);
      const del = await client.query('delete from t1 where id = $1 returning v', [1]);
      assert.deepEqual([del.command, del.rowCount, del.rows], ['DELETE', 1, [{ v: 'a!' }]]);
      const ddl = await client.query('drop table t1');
      assert.deepEqual([ddl.command, ddl.rowCount], ['DROP', null]);
    } finally {
      client.release();
    }
  });

  it('empty query', async () => {
    const result = await pool.query('');
    assert.deepEqual(result.rows, []);
    assert.equal(result.command, null);
    const results = await pool.simple('');
    assert.equal(results.length, 1);
  });

  it('notices and parameter status changes are handled', async () => {
    await pool.query(`do $$ begin raise notice 'hello %', 1; raise warning 'careful'; end $$`);
    assert.equal((await one('select 1 as ok')).ok, 1);
  });

  it('COPY FROM STDIN fails cleanly instead of hanging', async () => {
    await assert.rejects(pool.query('copy (select 1) to stdout').then(() => pool.simple('create temp table cp(x int); copy cp from stdin')), /not supported/);
    assert.equal((await one('select 2 as ok')).ok, 2);
  });
});

// ---------------------------------------------------------------------------
describe('errors', () => {
  it('unique violation 23505 with details, connection still usable', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      await p.query('create table if not exists uniq_test (email text constraint uniq_test_email unique)');
      await p.query('truncate uniq_test');
      await p.query('insert into uniq_test values ($1)', ['a@b.c']);
      const pidBefore = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      const err = await p.query('insert into uniq_test values ($1)', ['a@b.c']).catch((e) => e);
      assert.ok(err instanceof DatabaseError);
      assert.ok(err instanceof Error);
      assert.equal(err.code, '23505');
      assert.equal(err.constraint, 'uniq_test_email');
      assert.equal(err.table, 'uniq_test');
      assert.equal(err.schema, 'public');
      assert.equal(err.severity, 'ERROR');
      assert.match(err.detail, /already exists/);
      assert.equal(err.query, 'insert into uniq_test values ($1)');
      assert.match(err.stack, /query called from/);
      // Same connection, still works.
      const after = await p.query('select pg_backend_pid() as pid, count(*) as n from uniq_test');
      assert.equal(after.rows[0].pid, pidBefore);
      assert.equal(after.rows[0].n, 1);
      await p.query('drop table uniq_test');
    });
  });

  it('syntax error 42601 with position; long query text is truncated', async () => {
    const err = await pool.query('select from where').catch((e) => e);
    assert.equal(err.code, '42601');
    assert.equal(err.position, '13');
    assert.match(err.message, /syntax error/);
    const longSql = 'select ' + 'x'.repeat(2000) + ' from';
    const err2 = await pool.query(longSql).catch((e) => e);
    assert.equal(err2.query.length, 501);
    assert.equal((await one('select 1 as ok')).ok, 1);
  });

  it('errors inside simple() and a following query works', async () => {
    await assert.rejects(pool.simple('select 1; select 1/0; select 3'), { code: '22012' });
    assert.equal((await one('select 3 as ok')).ok, 3);
  });

  it('many errors in a row do not desync the connection', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      for (let i = 0; i < 20; i++) {
        await assert.rejects(p.query('select $1::int', ['not a number']), { code: '22P02' });
        assert.equal((await p.query('select $1::int as n', [i])).rows[0].n, i);
      }
      assert.equal(p.stats().total, 1);
    });
  });

  it('statementTimeoutMs cancels slow statements with 57014', async () => {
    await withPool({ connectionString: server.url, statementTimeoutMs: 100 }, async (p) => {
      await assert.rejects(p.query('select pg_sleep(2)'), { code: '57014' });
      assert.equal((await p.query(`select current_setting('statement_timeout') as s`)).rows[0].s, '100ms');
    });
  });

  it('connection refused rejects quickly', async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    await withPool({ connectionString: `postgres://u:p@127.0.0.1:${port}/db` }, async (p) => {
      await assert.rejects(p.query('select 1'), { code: 'ECONNREFUSED' });
      assert.deepEqual(p.stats(), { total: 0, idle: 0, waiting: 0 });
    });
  });

  it('connectTimeoutMs applies to a server that never answers', async () => {
    const sockets = [];
    const silent = net.createServer((socket) => sockets.push(socket));
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      await withPool({ connectionString: `postgres://u:p@127.0.0.1:${silent.address().port}/db`, connectTimeoutMs: 200 }, async (p) => {
        const started = Date.now();
        await assert.rejects(p.query('select 1'), { code: 'ETIMEDOUT' });
        assert.ok(Date.now() - started < 2000);
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
describe('pool', () => {
  it('50 concurrent queries on a pool of max 5', async () => {
    await withPool({ connectionString: server.url, max: 5 }, async (p) => {
      let maxTotal = 0;
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          p.query('select $1::int as i, pg_backend_pid() as pid, pg_sleep(0.02)', [i]).then((r) => {
            maxTotal = Math.max(maxTotal, p.stats().total);
            return r.rows[0];
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.i), Array.from({ length: 50 }, (_, i) => i));
      const pids = new Set(results.map((r) => r.pid));
      assert.ok(pids.size <= 5, `used ${pids.size} connections`);
      assert.ok(pids.size >= 2, 'queries should run in parallel');
      assert.ok(maxTotal <= 5);
      assert.deepEqual(p.stats(), { total: pids.size, idle: pids.size, waiting: 0 });
    });
  });

  it('waiters are served in FIFO order', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      const order = [];
      const holder = await p.connect();
      const pending = [1, 2, 3].map((n) => p.query('select $1::int as n', [n]).then((r) => order.push(r.rows[0].n)));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(p.stats().waiting, 3);
      holder.release();
      await Promise.all(pending);
      assert.deepEqual(order, [1, 2, 3]);
    });
  });

  it('queries on one client are serialized', async () => {
    const client = await pool.connect();
    try {
      const results = await Promise.all([1, 2, 3, 4].map((n) => client.query('select $1::int as n, pg_sleep(0.01)', [n])));
      assert.deepEqual(results.map((r) => r.rows[0].n), [1, 2, 3, 4]);
    } finally {
      client.release();
    }
    client.release(); // double release is a no-op
    await assert.rejects(client.query('select 1'), /already been released/);
  });

  it('idle connections are closed after idleTimeoutMs', async () => {
    await withPool({ connectionString: server.url, idleTimeoutMs: 100 }, async (p) => {
      await Promise.all([p.query('select pg_sleep(0.05)'), p.query('select pg_sleep(0.05)')]);
      assert.equal(p.stats().idle, 2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(p.stats(), { total: 0, idle: 0, waiting: 0 });
      assert.equal((await p.query('select 1 as ok')).rows[0].ok, 1);
    });
  });

  it('pg_terminate_backend on a pooled (idle) connection: pool emits error, next query succeeds', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    const poolErrors = [];
    p.on('error', (err) => poolErrors.push(err));
    try {
      const pid = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      await pool.query('select pg_terminate_backend($1)', [pid]);
      // Immediately query again: the idle connection may or may not have noticed yet.
      const result = await p.query('select pg_backend_pid() as pid');
      assert.notEqual(result.rows[0].pid, pid);
      // Give the event loop a moment so the idle-error path has definitely run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(poolErrors.length <= 1);
      if (poolErrors.length === 1) assert.equal(poolErrors[0].code, '57P01');
    } finally {
      await p.end();
    }
  });

  it('a query sent to an idle connection the server already killed is retried transparently', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    p.on('error', () => {});
    try {
      const pid = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      // Stop reading from the socket so the client cannot notice the termination in time:
      // this reproduces the race where a query is written to an already-dead backend.
      const idleConnection = p.idleConnections[0];
      idleConnection.socket.pause();
      await pool.query('select pg_terminate_backend($1)', [pid]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      setTimeout(() => idleConnection.socket.resume(), 50);
      const result = await p.query('select pg_backend_pid() as pid, 42 as answer');
      assert.equal(result.rows[0].answer, 42);
      assert.notEqual(result.rows[0].pid, pid);
      assert.equal(idleConnection.isDead, true);
    } finally {
      await p.end();
    }
  });

  it('transactions are never retried after a connection is killed', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    p.on('error', () => {});
    try {
      const pid = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      const idleConnection = p.idleConnections[0];
      idleConnection.socket.pause();
      await pool.query('select pg_terminate_backend($1)', [pid]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      setTimeout(() => idleConnection.socket.resume(), 50);
      let calls = 0;
      await assert.rejects(p.tx(async (c) => { calls++; await c.query('select 1'); }), { code: '57P01' });
      assert.equal(calls, 0);
      assert.equal((await p.query('select 1 as ok')).rows[0].ok, 1);
    } finally {
      await p.end();
    }
  });

  it('pg_terminate_backend after the idle connection noticed: pool error event, then fresh connection', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    const poolErrors = [];
    p.on('error', (err) => poolErrors.push(err));
    try {
      const pid = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      await pool.query('select pg_terminate_backend($1)', [pid]);
      for (let i = 0; i < 100 && poolErrors.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(poolErrors.length, 1);
      assert.equal(poolErrors[0].code, '57P01');
      assert.equal(p.stats().total, 0);
      assert.notEqual((await p.query('select pg_backend_pid() as pid')).rows[0].pid, pid);
    } finally {
      await p.end();
    }
  });

  it('idle connection errors without a listener are logged, not thrown', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const pid = (await p.query('select pg_backend_pid() as pid')).rows[0].pid;
      await pool.query('select pg_terminate_backend($1)', [pid]);
      for (let i = 0; i < 100 && logged.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(logged.length, 1);
      assert.match(logged[0], /idle connection error/);
    } finally {
      console.error = originalConsoleError;
      await p.end();
    }
  });

  it('a query in flight on a killed connection rejects; the pool recovers', async () => {
    await withPool({ connectionString: server.url, max: 2 }, async (p) => {
      const client = await p.connect();
      const pid = client.processId;
      const running = client.query('select pg_sleep(5)').catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await pool.query('select pg_terminate_backend($1)', [pid]);
      const err = await running;
      assert.ok(err instanceof Error);
      assert.equal(err.code, '57P01');
      assert.equal(err.query, 'select pg_sleep(5)');
      await assert.rejects(client.query('select 1'), /closed/);
      client.release();
      assert.equal(p.stats().total, 0);
      assert.equal((await p.query('select 1 as ok')).rows[0].ok, 1);
    });
  });

  it('a socket-level reset on a borrowed connection rejects the query', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      const client = await p.connect();
      const running = client.query('select pg_sleep(5)');
      client.connection.socket.destroy(); // simulate the network dropping
      await assert.rejects(running, /terminated unexpectedly|closed/);
      client.release();
      assert.equal((await p.query('select 1 as ok')).rows[0].ok, 1);
    });
  });

  it('releasing a client in the middle of a transaction discards the connection', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      const client = await p.connect();
      const pid = client.processId;
      await client.query('begin');
      client.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const row = (await p.query('select pg_backend_pid() as pid, now() = statement_timestamp() as fresh')).rows[0];
      assert.notEqual(row.pid, pid);
    });
  });

  it('pool.end() rejects new queries and waiting callers', async () => {
    const p = createPool({ connectionString: server.url, max: 1 });
    const holder = await p.connect();
    const waiting = p.query('select 1');
    const ended = p.end();
    await assert.rejects(waiting, /ended/);
    await assert.rejects(p.query('select 1'), /ended/);
    holder.release();
    await ended;
    assert.deepEqual(p.stats(), { total: 0, idle: 0, waiting: 0 });
  });

  it('pool.end() lets the process exit (child process)', async () => {
    const script = `
      const { createPool } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'lib', 'pg.js'))});
      (async () => {
        const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 3 });
        await Promise.all(Array.from({ length: 10 }, (_, i) => pool.query('select $1::int as n', [i])));
        await pool.tx(async (c) => c.query('select 1'));
        await pool.end();
        console.log('ended', JSON.stringify(pool.stats()));
      })().catch((err) => { console.error(err); process.exit(2); });
    `;
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DATABASE_URL: server.urlFor({ sslmode: server.sslEnabled ? 'require' : 'disable' }) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child did not exit after pool.end(); stdout=${stdout} stderr=${stderr}`));
      }, 10000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /ended {"total":0,"idle":0,"waiting":0}/);
  });
});

// ---------------------------------------------------------------------------
describe('transactions', () => {
  before(async () => {
    await pool.query('create table if not exists tx_test (id int primary key, v text)');
  });

  it('commits and returns the callback result', async () => {
    const result = await pool.tx(async (client) => {
      await client.query('insert into tx_test values ($1, $2)', [1, 'one']);
      await client.query('insert into tx_test values ($1, $2)', [2, 'two']);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal((await one('select count(*) as n from tx_test where id in (1,2)')).n, 2);
  });

  it('rolls back on throw and rethrows the original error', async () => {
    const boom = new Error('boom');
    await assert.rejects(
      pool.tx(async (client) => {
        await client.query('insert into tx_test values ($1, $2)', [3, 'three']);
        throw boom;
      }),
      (err) => err === boom,
    );
    assert.equal((await one('select count(*) as n from tx_test where id = 3')).n, 0);
  });

  it('rolls back on a database error inside the callback', async () => {
    await assert.rejects(
      pool.tx(async (client) => {
        await client.query('insert into tx_test values ($1, $2)', [4, 'four']);
        await client.query('insert into tx_test values ($1, $2)', [1, 'duplicate']);
      }),
      { code: '23505' },
    );
    assert.equal((await one('select count(*) as n from tx_test where id = 4')).n, 0);
    assert.equal(pool.stats().waiting, 0);
  });

  it('a failing COMMIT (deferred constraint) rejects and the connection is reusable', async () => {
    await withPool({ connectionString: server.url, max: 1 }, async (p) => {
      await p.query(`create table if not exists tx_deferred (id int, constraint tx_deferred_u unique (id) deferrable initially deferred)`);
      await p.query('truncate tx_deferred');
      await assert.rejects(
        p.tx(async (client) => {
          await client.query('insert into tx_deferred values (1), (1)');
        }),
        { code: '23505' },
      );
      assert.equal((await p.query('select count(*) as n from tx_deferred')).rows[0].n, 0);
      assert.equal(p.stats().total, 1);
      await p.query('drop table tx_deferred');
    });
  });

  it('isolation: uncommitted writes are invisible to other connections', async () => {
    await pool.tx(async (client) => {
      await client.query('insert into tx_test values (10, $1)', ['ten']);
      assert.equal((await one('select count(*) as n from tx_test where id = 10')).n, 0);
      assert.equal((await client.query('select count(*) as n from tx_test where id = 10')).rows[0].n, 1);
    });
    assert.equal((await one('select count(*) as n from tx_test where id = 10')).n, 1);
  });
});

// ---------------------------------------------------------------------------
describe('simple() for migrations', () => {
  it('runs a multi-statement migration and returns one result per statement', async () => {
    const migration = `
      create table mig_users (id bigserial primary key, email text not null unique, created_at timestamptz default now());
      create index mig_users_created on mig_users (created_at);
      insert into mig_users (email) values ('a@x.io'), ('b@x.io');
      -- a comment; with a semicolon
      create function mig_count() returns bigint language sql as $$ select count(*) from mig_users; $$;
      select mig_count() as n, 'it''s; fine' as s;
    `;
    const results = await pool.simple(migration);
    assert.deepEqual(results.map((r) => r.command), ['CREATE', 'CREATE', 'INSERT', 'CREATE', 'SELECT']);
    assert.equal(results[2].rowCount, 2);
    assert.deepEqual(results[4].rows, [{ n: 2, s: "it's; fine" }]);
  });

  it('a failing migration applies nothing (implicit transaction)', async () => {
    await assert.rejects(pool.simple(`create table mig_bad (id int); insert into mig_bad values ('x');`), { code: '22P02' });
    assert.equal((await one(`select to_regclass('mig_bad') is null as gone`)).gone, true);
  });
});

// ---------------------------------------------------------------------------
describe('large data', () => {
  it('200k-row select: correct count, reasonable speed', async () => {
    const started = Date.now();
    const { rows, rowCount } = await pool.query(
      `select g as id, 'row number ' || g as label, g % 2 = 0 as even, g::float8 / 3 as third
       from generate_series(1, 200000) g`,
    );
    const elapsed = Date.now() - started;
    assert.equal(rowCount, 200000);
    assert.equal(rows.length, 200000);
    assert.deepEqual(rows[199999], { id: 200000, label: 'row number 200000', even: true, third: 200000 / 3 });
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  });

  it('5MB text value round trip', async () => {
    const big = 'ab€🚀'.repeat(Math.ceil((5 * 1024 * 1024) / 9));
    assert.ok(Buffer.byteLength(big) >= 5 * 1024 * 1024);
    const row = await one('select $1::text as v, octet_length($1::text) as bytes', [big]);
    assert.equal(row.bytes, Buffer.byteLength(big));
    assert.ok(row.v === big);
  });

  it('rows larger than 64KB, many in one result', async () => {
    const { rows } = await pool.query(`select g, repeat(chr(65 + g), 100000) as v from generate_series(0, 20) g`);
    assert.equal(rows.length, 21);
    for (const row of rows) assert.equal(row.v, String.fromCharCode(65 + row.g).repeat(100000));
  });

  it('large bytea round trip (2MB)', async () => {
    const buffer = require('node:crypto').randomBytes(2 * 1024 * 1024);
    const row = await one('select $1::bytea as b', [buffer]);
    assert.ok(row.b.equals(buffer));
  });
});
