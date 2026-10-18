import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import net from 'node:net';
import ssh2 from 'ssh2';
const { Server: SshServer, utils: sshUtils } = ssh2;
import { WorkspaceClient } from '../dist/workspace-client.js';
import { sshTunnelManager } from '../dist/net/ssh-tunnel.js';
const directory = mkdtempSync(join(tmpdir(), 'omnisql-tls-'));
const containers = new Set(),
  clients = new Set(),
  sockets = new Set();
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
const workspace = new WorkspaceClient(undefined, 5000);
try {
  const certs = join(directory, 'certs');
  mkdirSync(certs, { mode: 0o700 });
  writeFileSync(
    join(certs, 'openssl.cnf'),
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=db.fixture\n[server]\nsubjectAltName=DNS:db.fixture\nextendedKeyUsage=serverAuth\n'
  );
  const openssl = (args) => execFileSync('openssl', args, { cwd: certs, stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=OmniSQL synthetic CA',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-config',
    'openssl.cnf',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.pem',
    '-days',
    '1',
    '-extfile',
    'openssl.cnf',
    '-extensions',
    'server',
  ]);
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const sshPassword = randomBytes(20).toString('hex');
  const targets = new Set();
  server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === sshPassword)
        ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== 'db.fixture' || !targets.has(info.destPort)) {
          reject();
          return;
        }
        const upstream = net.connect({ host: '127.0.0.1', port: info.destPort });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        const channel = accept();
        channel.pipe(upstream).pipe(channel);
        upstream.on('error', () => channel.destroy());
        channel.on('error', () => upstream.destroy());
        channel.on('close', () => upstream.destroy());
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sshPort = server.address().port;
  const publicKey = sshUtils.parseKey(hostKey).getPublicSSH();
  const knownHosts = join(directory, 'known_hosts');
  writeFileSync(knownHosts, `[127.0.0.1]:${sshPort} ssh-rsa ${publicKey.toString('base64')}\n`, {
    mode: 0o600,
  });
  process.env.OMNISQL_SSH_KNOWN_HOSTS = knownHosts;
  process.env.OMNISQL_SSH_STRICT_HOST_KEY = 'true';
  for (const engine of ['postgres', 'mysql']) {
    const password = 'T_' + randomBytes(20).toString('hex');
    const name = 'omnisql-tls-' + engine + '-' + randomBytes(4).toString('hex');
    const user = engine === 'postgres' ? 'postgres' : 'mysql';
    const launch = `#!/bin/sh\nset -eu\nmkdir -p /tmp/omnisql-certs\ncp /certs/ca.pem /certs/server.pem /certs/server.key /tmp/omnisql-certs/\nchown -R ${user}:${user} /tmp/omnisql-certs\nchmod 600 /tmp/omnisql-certs/server.key\nexec docker-entrypoint.sh ${engine === 'postgres' ? 'postgres -c ssl=on -c ssl_cert_file=/tmp/omnisql-certs/server.pem -c ssl_key_file=/tmp/omnisql-certs/server.key -c ssl_ca_file=/tmp/omnisql-certs/ca.pem' : 'mysqld --ssl-ca=/tmp/omnisql-certs/ca.pem --ssl-cert=/tmp/omnisql-certs/server.pem --ssl-key=/tmp/omnisql-certs/server.key --require_secure_transport=ON'}\n`;
    const script = join(certs, engine + '-start.sh');
    writeFileSync(script, launch, { mode: 0o700 });
    const variables =
      engine === 'postgres'
        ? { POSTGRES_USER: 'fixture', POSTGRES_PASSWORD: password, POSTGRES_DB: 'fixture' }
        : {
            MYSQL_ROOT_PASSWORD: password,
            MYSQL_DATABASE: 'fixture',
            MYSQL_USER: 'fixture',
            MYSQL_PASSWORD: password,
          };
    const internalPort = engine === 'postgres' ? 5432 : 3306;
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'io.omnisql.integration=true',
      '-p',
      `127.0.0.1::${internalPort}`,
      '-v',
      `${certs}:/certs:ro`,
      '--entrypoint',
      '/bin/sh',
      ...Object.entries(variables).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      engine === 'postgres' ? 'postgres:17-alpine' : 'mysql:8.4',
      '/certs/' + engine + '-start.sh',
    ]);
    containers.add(name);
    let port;
    for (let i = 0; i < 50; i++) {
      const info = JSON.parse(
        docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])
      );
      port = Number(info?.[`${internalPort}/tcp`]?.[0]?.HostPort);
      if (port) break;
      await delay(100);
    }
    assert(port);
    targets.add(port);
    const connection = {
      id: engine,
      name: engine,
      driver: engine === 'postgres' ? 'postgresql' : 'mysql',
      url: '',
      host: 'db.fixture',
      port,
      database: 'fixture',
      user: 'fixture',
      readonly: true,
      sshTunnel: {
        enabled: true,
        host: '127.0.0.1',
        port: sshPort,
        user: 'fixture',
        password: sshPassword,
        authType: 'PASSWORD',
      },
      properties: {
        password,
        sslmode: engine === 'postgres' ? 'verify-full' : 'VERIFY_IDENTITY',
        sslrootcert: join(certs, 'ca.pem'),
      },
    };
    let ready = false,
      lastError;
    for (let i = 0; i < 90; i++) {
      try {
        const result = await workspace.executeQuery(connection, 'SELECT 1 AS value');
        assert.equal(Number(result.rows[0][0]), 1);
        ready = true;
        break;
      } catch (error) {
        lastError = error;
        await delay(1000);
      }
    }
    if (!ready) throw new Error(`${engine} verified TLS through SSH failed: ${lastError?.message}`);
    const wrongName = {
      ...connection,
      id: engine + '-wrong-name',
      properties: { ...connection.properties, 'ssl.serverName': 'wrong.fixture' },
    };
    await assert.rejects(
      () => workspace.executeQuery(wrongName, 'SELECT 1'),
      /certificate|hostname|altnames|cert/i
    );
    const missingCa = {
      ...connection,
      id: engine + '-missing-ca',
      properties: { ...connection.properties, sslrootcert: join(certs, 'does-not-exist.pem') },
    };
    await assert.rejects(
      () => workspace.executeQuery(missingCa, 'SELECT 1'),
      /Cannot read configured TLS/
    );
    console.log(
      `${engine}: trusted host key, verified TLS through SSH, wrong-host rejection, and missing-CA rejection passed`
    );
    await workspace.close();
    await sshTunnelManager.closeAll();
    docker(['rm', '-f', '-v', name]);
    containers.delete(name);
  }
} finally {
  await workspace.close();
  await sshTunnelManager.closeAll();
  for (const client of clients) client.end();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const name of containers) {
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      /* already removed */
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
