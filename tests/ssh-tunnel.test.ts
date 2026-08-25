import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import net from 'net';
import { Server as SshServer } from 'ssh2';
import {
  SshTunnelManager,
  buildConnectOptions,
  detectKeyType,
  expandHome,
  resolveAuthType,
} from '../src/net/ssh-tunnel.js';
import { parseKnownHosts, verifyHostKey } from '../src/net/known-hosts.js';
import { readSshTunnel } from '../src/config-parser.js';
import { DatabaseConnection } from '../src/types.js';

describe('readSshTunnel', () => {
  // The exact block DBeaver writes for a tunneled connection (issue #28).
  const handlers = {
    ssh_tunnel: {
      type: 'TUNNEL',
      enabled: true,
      properties: {
        host: 'db-host.internal.example.com',
        port: 22,
        authType: 'AGENT',
      },
    },
  };

  it('should read the SSH endpoint out of the handler', () => {
    const tunnel = readSshTunnel(handlers);
    expect(tunnel).toMatchObject({
      enabled: true,
      host: 'db-host.internal.example.com',
      port: 22,
      authType: 'AGENT',
    });
  });

  it('should default the SSH port to 22', () => {
    const tunnel = readSshTunnel({ ssh_tunnel: { enabled: true, properties: { host: 'jump' } } });
    expect(tunnel?.port).toBe(22);
  });

  it('should report a disabled handler as disabled rather than absent', () => {
    // The distinction matters: disabled means the connection really is direct.
    const tunnel = readSshTunnel({
      ssh_tunnel: { enabled: false, properties: { host: 'jump' } },
    });
    expect(tunnel?.enabled).toBe(false);
  });

  it('should accept the property spellings that vary across DBeaver versions', () => {
    const tunnel = readSshTunnel({
      ssh_tunnel: {
        enabled: true,
        properties: {
          host: 'jump',
          userName: 'deploy',
          authType: 'PUBLIC_KEY',
          privKeyPath: '~/.ssh/id_ed25519',
        },
      },
    });
    expect(tunnel).toMatchObject({ user: 'deploy', privateKeyPath: '~/.ssh/id_ed25519' });
  });

  it('should return undefined when there is no tunnel', () => {
    expect(readSshTunnel(undefined)).toBeUndefined();
    expect(readSshTunnel({})).toBeUndefined();
    expect(readSshTunnel({ postgre_ssl: { enabled: true } })).toBeUndefined();
    // A handler with no host is not usable as one.
    expect(readSshTunnel({ ssh_tunnel: { enabled: true, properties: {} } })).toBeUndefined();
  });
});

describe('resolveAuthType', () => {
  const base = { enabled: true, host: 'jump', port: 22, user: 'me' };

  it('should honour a declared authType', () => {
    expect(resolveAuthType({ ...base, authType: 'password' })).toBe('PASSWORD');
    expect(resolveAuthType({ ...base, authType: 'PUBLIC_KEY' })).toBe('PUBLIC_KEY');
  });

  it('should infer from the material when authType is absent', () => {
    expect(resolveAuthType({ ...base, privateKeyPath: '/k' })).toBe('PUBLIC_KEY');
    expect(resolveAuthType({ ...base, password: 'pw' })).toBe('PASSWORD');
    expect(resolveAuthType(base)).toBe('AGENT');
  });
});

describe('buildConnectOptions', () => {
  const base = { enabled: true, host: 'jump', port: 22, user: 'me' };

  it('should explain a missing agent instead of failing at connect time', () => {
    const saved = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      expect(() => buildConnectOptions({ ...base, authType: 'AGENT' }, 'Reporting')).toThrow(
        /SSH_AUTH_SOCK/
      );
    } finally {
      if (saved !== undefined) process.env.SSH_AUTH_SOCK = saved;
      vi.restoreAllMocks();
    }
  });

  it('should explain a missing password rather than trying an empty one', () => {
    expect(() => buildConnectOptions({ ...base, authType: 'PASSWORD' }, 'Reporting')).toThrow(
      /no password is stored/
    );
  });

  it('should explain an unreadable private key', () => {
    expect(() =>
      buildConnectOptions(
        { ...base, authType: 'PUBLIC_KEY', privateKeyPath: '/definitely/not/here' },
        'Reporting'
      )
    ).toThrow(/could not read its private key/);
  });

  it('should require a username', () => {
    expect(() => buildConnectOptions({ ...base, user: undefined }, 'Reporting')).toThrow(
      /no username/
    );
  });
});

describe('expandHome', () => {
  it('should expand a leading ~, which DBeaver stores verbatim', () => {
    expect(expandHome('~/.ssh/id_rsa')).toMatch(/\/\.ssh\/id_rsa$/);
    expect(expandHome('~/.ssh/id_rsa').startsWith('~')).toBe(false);
    expect(expandHome('/absolute/id_rsa')).toBe('/absolute/id_rsa');
  });
});

describe('known_hosts verification', () => {
  const key = Buffer.from('a-host-key-blob');
  const encoded = key.toString('base64');

  it('should match a plain entry', () => {
    const entries = parseKnownHosts(`jump.example.com ssh-ed25519 ${encoded}\n`);
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe('match');
  });

  it('should match a hashed entry', () => {
    // OpenSSH hashes the host with HMAC-SHA1 under a random salt.
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac('sha1', salt).update('jump.example.com').digest('base64');
    const entries = parseKnownHosts(
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${encoded}\n`
    );
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe('match');
  });

  it('should report a different key for a known host as a mismatch', () => {
    const entries = parseKnownHosts(`jump.example.com ssh-ed25519 ${encoded}\n`);
    const other = Buffer.from('a-different-key');
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', other, entries)).toEqual({
      status: 'mismatch',
      expectedTypes: ['ssh-ed25519'],
    });
  });

  it('should treat a revoked key as a mismatch', () => {
    const entries = parseKnownHosts(`@revoked jump.example.com ssh-ed25519 ${encoded}\n`);
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe(
      'mismatch'
    );
  });

  it('should report an unseen host as unknown, not as a mismatch', () => {
    const entries = parseKnownHosts(`other.example.com ssh-ed25519 ${encoded}\n`);
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe(
      'unknown'
    );
  });

  it('should match a non-default port in its bracketed form', () => {
    const entries = parseKnownHosts(`[jump.example.com]:2222 ssh-ed25519 ${encoded}\n`);
    expect(verifyHostKey('jump.example.com', 2222, 'ssh-ed25519', key, entries).status).toBe(
      'match'
    );
    // ...and that entry says nothing about the default port.
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe(
      'unknown'
    );
  });

  it('should honour comma-separated patterns and wildcards', () => {
    const entries = parseKnownHosts(`alias,*.example.com ssh-ed25519 ${encoded}\n`);
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe('match');
    expect(verifyHostKey('alias', 22, 'ssh-ed25519', key, entries).status).toBe('match');
  });

  it('should skip comments and @cert-authority entries', () => {
    const entries = parseKnownHosts(
      `# a comment\n@cert-authority *.example.com ssh-ed25519 ${encoded}\n`
    );
    // A CA-signed host is not a comparison we can make, so it reads as unknown.
    expect(verifyHostKey('jump.example.com', 22, 'ssh-ed25519', key, entries).status).toBe(
      'unknown'
    );
  });
});

describe('detectKeyType', () => {
  it('should read the algorithm name out of a host key blob', () => {
    const name = 'ssh-ed25519';
    const blob = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(name.length);
        return b;
      })(),
      Buffer.from(name),
      Buffer.from('key material'),
    ]);
    expect(detectKeyType(blob)).toBe(name);
  });

  it('should return empty for a truncated blob rather than throwing', () => {
    expect(detectKeyType(Buffer.alloc(0))).toBe('');
    expect(detectKeyType(Buffer.from([0, 0, 0, 99]))).toBe('');
  });
});

/**
 * End-to-end: a real ssh2 server, a real forward, a real socket through it.
 *
 * This is the behaviour issue #28 is about - that the bytes reach the machine
 * on the far side of the tunnel rather than the local port of the same number.
 */
describe('SshTunnelManager end to end', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function hostKey(): string {
    return crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
  }

  /** A TCP server that echoes back what it is sent, standing in for a database. */
  async function startEchoServer(): Promise<number> {
    const server = net.createServer((socket) => socket.pipe(socket));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  /** An SSH server that accepts anything and honours direct-tcpip forwards. */
  async function startSshServer(): Promise<number> {
    const server = new SshServer({ hostKeys: [hostKey()] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('request', (accept) => accept?.());
      });
      client.on('tcpip', (accept, _reject, info) => {
        const channel = accept();
        const upstream = net.connect(info.destPort, info.destIP, () => {
          channel.pipe(upstream).pipe(channel);
        });
        upstream.on('error', () => channel.end());
      });
    });
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  it('should forward traffic to the target seen from the SSH server', async () => {
    const dbPort = await startEchoServer();
    const sshPort = await startSshServer();

    const manager = new SshTunnelManager();
    cleanups.push(() => void manager.closeAll());

    const connection = {
      id: 'tunneled-1',
      name: 'Tunneled',
      driver: 'postgres-jdbc',
      url: '',
      // What DBeaver records: the database as the SSH server sees it.
      host: '127.0.0.1',
      port: dbPort,
      sshTunnel: {
        enabled: true,
        host: '127.0.0.1',
        port: sshPort,
        user: 'anyone',
        authType: 'PASSWORD',
        password: 'anything',
      },
    } as DatabaseConnection;

    const endpoint = await manager.resolveEndpoint(connection, 5432);
    expect(endpoint).not.toBeNull();
    expect(endpoint!.host).toBe('127.0.0.1');
    // The whole point: a local port of our choosing, not the recorded one.
    expect(endpoint!.port).not.toBe(dbPort);

    const roundTrip = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(endpoint!.port, endpoint!.host, () => socket.write('ping'));
      socket.on('data', (data) => {
        resolve(data.toString());
        socket.end();
      });
      socket.on('error', reject);
    });

    expect(roundTrip).toBe('ping');
  }, 20000);

  it('should reuse one tunnel across concurrent callers', async () => {
    const dbPort = await startEchoServer();
    const sshPort = await startSshServer();

    const manager = new SshTunnelManager();
    cleanups.push(() => void manager.closeAll());

    const connection = {
      id: 'tunneled-2',
      name: 'Tunneled',
      driver: 'postgres-jdbc',
      url: '',
      host: '127.0.0.1',
      port: dbPort,
      sshTunnel: {
        enabled: true,
        host: '127.0.0.1',
        port: sshPort,
        user: 'anyone',
        authType: 'PASSWORD',
        password: 'anything',
      },
    } as DatabaseConnection;

    // The direct-query and pooled paths both ask, often at once.
    const [a, b] = await Promise.all([
      manager.resolveEndpoint(connection, 5432),
      manager.resolveEndpoint(connection, 5432),
    ]);

    expect(a!.port).toBe(b!.port);
    expect(manager.hasTunnel('tunneled-2')).toBe(true);

    await manager.close('tunneled-2');
    expect(manager.hasTunnel('tunneled-2')).toBe(false);
  }, 20000);

  it('should not tunnel a connection whose handler is disabled', async () => {
    const manager = new SshTunnelManager();
    const connection = {
      id: 'direct-1',
      name: 'Direct',
      driver: 'postgres-jdbc',
      url: '',
      host: 'db.example.com',
      port: 5432,
      sshTunnel: { enabled: false, host: 'jump', port: 22 },
    } as DatabaseConnection;

    expect(await manager.resolveEndpoint(connection, 5432)).toBeNull();
  });

  it('should surface a refused SSH connection as a tunnel failure', async () => {
    // A closed port stands in for an unreachable jump host. The failure must
    // name the tunnel rather than fall through to the recorded host.
    const dead = net.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const manager = new SshTunnelManager();
    const connection = {
      id: 'tunneled-3',
      name: 'Reporting',
      driver: 'postgres-jdbc',
      url: '',
      host: 'localhost',
      port: 5432,
      sshTunnel: {
        enabled: true,
        host: '127.0.0.1',
        port: deadPort,
        user: 'anyone',
        authType: 'PASSWORD',
        password: 'anything',
      },
    } as DatabaseConnection;

    await expect(manager.resolveEndpoint(connection, 5432)).rejects.toThrow(
      /SSH tunnel to 127\.0\.0\.1:\d+ for connection "Reporting"/
    );
  }, 20000);
});
