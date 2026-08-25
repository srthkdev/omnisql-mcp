/**
 * SSH tunnels for connections that DBeaver reaches through one.
 *
 * A tunneled connection records its target as it looks *from the SSH server* -
 * usually `localhost` - and keeps the real jump host under
 * `handlers.ssh_tunnel`. DBeaver opens a local forward and points the driver
 * at it. Reading the target host without opening that forward is how such a
 * connection ends up talking to whatever happens to be on the same port of the
 * local machine, so this module reproduces the forward instead.
 */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { DatabaseConnection, SshTunnelConfig } from '../types.js';
import { keyFingerprint, knownHostsPath, loadKnownHosts, verifyHostKey } from './known-hosts.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

export interface TunnelEndpoint {
  host: string;
  port: number;
}

interface ActiveTunnel extends TunnelEndpoint {
  close: () => Promise<void>;
}

/** Expand a leading `~`, which DBeaver stores verbatim in key paths. */
export function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Decide how to authenticate to the SSH server.
 *
 * DBeaver records an explicit `authType`, but older configs and hand-edited
 * ones omit it, so fall back to whatever material is actually present.
 */
export function resolveAuthType(config: SshTunnelConfig): 'AGENT' | 'PASSWORD' | 'PUBLIC_KEY' {
  const declared = (config.authType ?? '').toUpperCase();
  if (declared === 'AGENT' || declared === 'PASSWORD' || declared === 'PUBLIC_KEY') {
    return declared;
  }
  if (config.privateKeyPath) {
    return 'PUBLIC_KEY';
  }
  if (config.password) {
    return 'PASSWORD';
  }
  return 'AGENT';
}

/** Build the ssh2 connect options, failing loudly on missing material. */
export function buildConnectOptions(
  config: SshTunnelConfig,
  connectionName: string
): Record<string, unknown> {
  const authType = resolveAuthType(config);

  const base: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.user,
    readyTimeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  };

  if (!config.user) {
    throw new Error(
      `SSH tunnel for "${connectionName}" has no username. Set the SSH user on the ` +
        `connection's SSH tab, or save its credentials so they can be read from the workspace.`
    );
  }

  if (authType === 'PASSWORD') {
    if (!config.password) {
      throw new Error(
        `SSH tunnel for "${connectionName}" uses password authentication but no password is ` +
          `stored. Enable "Save password" on the connection's SSH tab, or switch it to key or ` +
          `agent authentication.`
      );
    }
    return { ...base, password: config.password };
  }

  if (authType === 'PUBLIC_KEY') {
    if (!config.privateKeyPath) {
      throw new Error(
        `SSH tunnel for "${connectionName}" uses public key authentication but records no ` +
          `private key path.`
      );
    }
    const keyPath = expandHome(config.privateKeyPath);
    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(keyPath);
    } catch (error) {
      throw new Error(
        `SSH tunnel for "${connectionName}" could not read its private key at "${keyPath}": ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      ...base,
      privateKey,
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
    };
  }

  // AGENT: DBeaver's default, and the only one that works with a hardware key
  // or an unlocked SSO agent.
  const agent = process.env.SSH_AUTH_SOCK || (os.platform() === 'win32' ? 'pageant' : undefined);
  if (!agent) {
    throw new Error(
      `SSH tunnel for "${connectionName}" is set to agent authentication but SSH_AUTH_SOCK is ` +
        `not set in this process. MCP servers are launched by the client, which often does not ` +
        `inherit your shell environment - set SSH_AUTH_SOCK explicitly in the server's env ` +
        `config, or switch the connection to key authentication.`
    );
  }
  return { ...base, agent };
}

export class SshTunnelManager {
  private tunnels = new Map<string, ActiveTunnel>();
  private pending = new Map<string, Promise<ActiveTunnel>>();
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * The tunnel manager is shared by the direct-query and pooled paths, so it is
   * a singleton constructed before the server has parsed its own options.
   */
  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[SshTunnel] ${message}`);
    }
  }

  /**
   * Return the local endpoint to connect to for this connection, opening the
   * tunnel first if it is not already up. Connections without a tunnel are
   * returned unchanged.
   */
  async resolveEndpoint(
    connection: DatabaseConnection,
    defaultPort: number
  ): Promise<TunnelEndpoint | null> {
    const config = connection.sshTunnel;
    if (!config || !config.enabled) {
      return null;
    }

    const key = connection.id;
    const existing = this.tunnels.get(key);
    if (existing) {
      return { host: existing.host, port: existing.port };
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      const tunnel = await inFlight;
      return { host: tunnel.host, port: tunnel.port };
    }

    const destHost = connection.host || 'localhost';
    const destPort = connection.port || defaultPort;

    const creation = this.open(connection, config, destHost, destPort);
    this.pending.set(key, creation);
    try {
      const tunnel = await creation;
      this.tunnels.set(key, tunnel);
      return { host: tunnel.host, port: tunnel.port };
    } finally {
      this.pending.delete(key);
    }
  }

  private async open(
    connection: DatabaseConnection,
    config: SshTunnelConfig,
    destHost: string,
    destPort: number
  ): Promise<ActiveTunnel> {
    const options = buildConnectOptions(config, connection.name);

    // Imported lazily so a workspace with no tunneled connections never pays
    // for it, and so a broken optional native dep degrades to a clear message.
    let SshClient: new () => import('ssh2').Client;
    try {
      ({ Client: SshClient } = await import('ssh2'));
    } catch (error) {
      throw new Error(
        `Connection "${connection.name}" needs an SSH tunnel, but the ssh2 module could not be ` +
          `loaded: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const client = new SshClient();
    const knownHosts = loadKnownHosts();
    const strict = String(process.env.OMNISQL_SSH_STRICT_HOST_KEY ?? '').toLowerCase() === 'true';
    let hostKeyError: Error | undefined;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        client.removeListener('ready', onReady);
        // A rejected host key closes the transport, and ssh2 reports that
        // close rather than the reason - so prefer the reason we recorded.
        reject(hostKeyError ?? this.decorateSshError(error, connection.name, config));
      };
      const onReady = () => {
        client.removeListener('error', onError);
        resolve();
      };

      client.once('ready', onReady);
      client.once('error', onError);

      client.connect({
        ...options,
        hostVerifier: (key: Buffer, callback: (ok: boolean) => void) => {
          const verdict = verifyHostKey(
            config.host,
            config.port,
            detectKeyType(key),
            key,
            knownHosts
          );

          if (verdict.status === 'match') {
            callback(true);
            return;
          }

          if (verdict.status === 'mismatch') {
            hostKeyError = new Error(
              `Host key verification failed for SSH host ${config.host}:${config.port}. The key ` +
                `it presented (${keyFingerprint(key)}) does not match the ${verdict.expectedTypes.join(
                  ', '
                )} entry in ${knownHostsPath()}. Refusing to tunnel database credentials ` +
                `through it. If the host was legitimately rekeyed, remove the stale entry.`
            );
            callback(false);
            return;
          }

          if (strict) {
            hostKeyError = new Error(
              `SSH host ${config.host}:${config.port} is not in ${knownHostsPath()} and ` +
                `OMNISQL_SSH_STRICT_HOST_KEY is set. Its key is ${keyFingerprint(key)}; connect ` +
                `once with ssh to record it, then retry.`
            );
            callback(false);
            return;
          }

          this.log(
            `SSH host ${config.host}:${config.port} is not in known_hosts; accepting ` +
              `${keyFingerprint(key)}. Set OMNISQL_SSH_STRICT_HOST_KEY=true to require an entry.`
          );
          callback(true);
        },
      } as Parameters<import('ssh2').Client['connect']>[0]);
    });

    // Bind to loopback only: this forward is for this process, and anything
    // reachable on it inherits the SSH server's access to the database.
    const server = net.createServer((socket) => {
      client.forwardOut(
        '127.0.0.1',
        socket.remotePort ?? 0,
        destHost,
        destPort,
        (error, stream) => {
          if (error) {
            this.log(`Forward to ${destHost}:${destPort} failed: ${error.message}`);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        }
      );
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to allocate a local port for the SSH tunnel'));
        }
      });
    });

    this.log(
      `Tunnel up for "${connection.name}": 127.0.0.1:${localPort} -> ` +
        `${config.host}:${config.port} -> ${destHost}:${destPort}`
    );

    return {
      host: '127.0.0.1',
      port: localPort,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            client.end();
            resolve();
          });
        }),
    };
  }

  /**
   * The SSH layer's own errors say nothing about which connection was being
   * opened, which is what the user needs to act.
   */
  private decorateSshError(error: Error, connectionName: string, config: SshTunnelConfig): Error {
    const target = `${config.host}:${config.port}`;
    const message = error.message || String(error);

    if (/All configured authentication methods failed/i.test(message)) {
      return new Error(
        `SSH authentication to ${target} failed for the tunnel behind connection ` +
          `"${connectionName}" (as ${config.user}, ${resolveAuthType(config).toLowerCase()} auth). ` +
          `${message}`
      );
    }

    return new Error(
      `Could not open the SSH tunnel to ${target} for connection "${connectionName}": ${message}`
    );
  }

  async close(connectionId: string): Promise<void> {
    const tunnel = this.tunnels.get(connectionId);
    if (!tunnel) {
      return;
    }
    this.tunnels.delete(connectionId);
    try {
      await tunnel.close();
    } catch (error) {
      this.log(`Error closing tunnel for ${connectionId}: ${error}`);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.tunnels.keys()).map((id) => this.close(id)));
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }
}

/**
 * Read the algorithm name out of an SSH host key blob.
 *
 * The wire format is a length-prefixed string, and it is the same name
 * known_hosts records in its key-type column.
 */
export function detectKeyType(key: Buffer): string {
  if (key.length < 4) {
    return '';
  }
  const length = key.readUInt32BE(0);
  if (length <= 0 || key.length < 4 + length) {
    return '';
  }
  return key.subarray(4, 4 + length).toString('utf8');
}

export const sshTunnelManager = new SshTunnelManager();
