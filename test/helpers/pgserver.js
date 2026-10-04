'use strict';

/*
 * Starts a throwaway PostgreSQL 16 server for tests.
 *
 *   const server = await startPgServer();
 *   server.url                  // postgres://castvoo:<encoded pw>@127.0.0.1:<port>/postgres?sslmode=disable
 *   server.urlFor({ user, password, sslmode })
 *   await server.stop();        // stops postgres and deletes the temp directory
 *
 * The cluster is created with scram-sha-256 auth for the superuser "castvoo".
 * pg_hba.conf also has per-user lines so the tests can exercise other methods:
 *   md5user   -> md5        (the test creates the role with an md5-hashed password)
 *   clearuser -> password   (cleartext)
 *   trustuser -> trust
 * The server runs with ssl=on and a self-signed certificate (if openssl exists),
 * and the "host" lines accept both SSL and non-SSL connections.
 *
 * PostgreSQL refuses to run as root, so when the tests run as root every server
 * command runs as "nobody" via `runuser` (or `su` as a fallback).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawnSync } = require('node:child_process');

const PG_BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';
const SUPERUSER = 'castvoo';
const SUPERUSER_PASSWORD = 'test pass:w/ord@1';
const RUN_AS_USER = 'nobody';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let privilegeDropMethod = null;
function detectPrivilegeDropMethod() {
  if (privilegeDropMethod) return privilegeDropMethod;
  if (spawnSync('runuser', ['-u', RUN_AS_USER, '--', 'true']).status === 0) {
    privilegeDropMethod = 'runuser';
  } else if (spawnSync('su', [RUN_AS_USER, '-s', '/bin/sh', '-c', 'true']).status === 0) {
    privilegeDropMethod = 'su';
  } else {
    throw new Error(`Running as root but cannot switch to user "${RUN_AS_USER}" with runuser or su`);
  }
  return privilegeDropMethod;
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/** Runs a server binary, as "nobody" when we are root. Throws with output on failure. */
function runServerCommand(binary, args, { cwd } = {}) {
  let command = path.join(PG_BIN, binary);
  let commandArgs = args;
  if (isRoot) {
    if (detectPrivilegeDropMethod() === 'runuser') {
      commandArgs = ['-u', RUN_AS_USER, '--', command, ...args];
      command = 'runuser';
    } else {
      commandArgs = [RUN_AS_USER, '-s', '/bin/sh', '-c', [command, ...args].map(shellQuote).join(' ')];
      command = 'su';
    }
  }
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    throw new Error(
      `${binary} failed (status ${result.status}): ${result.error ? result.error.message : ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

let serverUid = null;
function giveToServerUser(filePath) {
  if (!isRoot) return;
  if (serverUid === null) {
    serverUid = {
      uid: Number(execFileSync('id', ['-u', RUN_AS_USER], { encoding: 'utf8' }).trim()),
      gid: Number(execFileSync('id', ['-g', RUN_AS_USER], { encoding: 'utf8' }).trim()),
    };
  }
  fs.chownSync(filePath, serverUid.uid, serverUid.gid);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function hasOpenssl() {
  return spawnSync('openssl', ['version']).status === 0;
}

function writeServerFile(filePath, content, mode = 0o600) {
  fs.writeFileSync(filePath, content, { mode });
  giveToServerUser(filePath);
}

async function startPgServer({ ssl = true } = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'castvoo-pgtest-'));
  const dataDir = path.join(baseDir, 'data');
  const logFile = path.join(baseDir, 'postgres.log');
  const passwordFile = path.join(baseDir, 'pwfile');
  let started = false;
  let stopped = false;

  const exitHook = () => cleanupSync('immediate');

  function cleanupSync(mode) {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', exitHook);
    if (started) {
      try {
        runServerCommand('pg_ctl', ['-D', dataDir, '-m', mode, '-w', 'stop'], { cwd: baseDir });
      } catch {
        // already stopped
      }
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  function readLog() {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch {
      return '(no log)';
    }
  }

  process.on('exit', exitHook); // last-resort cleanup if the test process dies

  try {
    giveToServerUser(baseDir);
    writeServerFile(passwordFile, SUPERUSER_PASSWORD + '\n');

    runServerCommand(
      'initdb',
      [
        '-D', dataDir,
        '--auth=scram-sha-256',
        `--username=${SUPERUSER}`,
        `--pwfile=${passwordFile}`,
        '--encoding=UTF8',
        '--locale=C',
        '--no-sync',
      ],
      { cwd: baseDir },
    );

    const hba = [
      '# TYPE  DATABASE  USER       ADDRESS        METHOD',
      'local   all       all                       trust',
      'host    all       md5user    127.0.0.1/32   md5',
      'host    all       clearuser  127.0.0.1/32   password',
      'host    all       trustuser  127.0.0.1/32   trust',
      'host    all       all        127.0.0.1/32   scram-sha-256',
      '',
    ].join('\n');
    writeServerFile(path.join(dataDir, 'pg_hba.conf'), hba);

    const settings = ['fsync = off', 'synchronous_commit = off', 'full_page_writes = off', 'max_connections = 100'];
    const sslEnabled = ssl && hasOpenssl();
    if (sslEnabled) {
      const certFile = path.join(baseDir, 'server.crt');
      const keyFile = path.join(baseDir, 'server.key');
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost'],
        { stdio: 'ignore' },
      );
      fs.chmodSync(keyFile, 0o600);
      giveToServerUser(keyFile);
      giveToServerUser(certFile);
      settings.push('ssl = on', `ssl_cert_file = '${certFile}'`, `ssl_key_file = '${keyFile}'`);
    }
    fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), '\n' + settings.join('\n') + '\n');

    const port = await findFreePort();
    runServerCommand(
      'pg_ctl',
      ['-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${port} -k ${baseDir} -c listen_addresses=127.0.0.1`, 'start'],
      { cwd: baseDir },
    );
    started = true;

    function urlFor({ user = SUPERUSER, password = SUPERUSER_PASSWORD, database = 'postgres', sslmode = 'disable' } = {}) {
      const auth = password === null ? encodeURIComponent(user) : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      const query = sslmode ? `?sslmode=${sslmode}` : '';
      return `postgres://${auth}@127.0.0.1:${port}/${database}${query}`;
    }

    return {
      url: urlFor(),
      urlFor,
      host: '127.0.0.1',
      port,
      user: SUPERUSER,
      password: SUPERUSER_PASSWORD,
      sslEnabled,
      dataDir,
      readLog,
      async stop() {
        cleanupSync('fast');
      },
    };
  } catch (err) {
    err.message += `\n--- postgres log ---\n${readLog()}`;
    cleanupSync('immediate');
    throw err;
  }
}

module.exports = { startPgServer, SUPERUSER, SUPERUSER_PASSWORD };
