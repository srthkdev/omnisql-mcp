import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import crypto from 'crypto';
import { DatabaseConnection, SshTunnelConfig, WorkspaceConfig } from './types.js';
import {
  resolveDriverDialect,
  parseJdbcUrl,
  parseConnectionId,
  isFileBackedDriver,
} from './utils.js';

const parseXML = promisify(parseString);

// The local DB client (DBeaver-compatible) uses these hardcoded values for password encryption
const WORKSPACE_AES_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');
const WORKSPACE_AES_IV = Buffer.alloc(16, 0);

// Default project/workspace folder name used by the local DB client (DBeaver-compatible)
const DEFAULT_PROJECT_NAME = 'General';

/**
 * Read a connection's SSH tunnel handler.
 *
 * The workspace keeps network handlers alongside the connection configuration,
 * keyed by handler id, with the SSH server's own endpoint under `properties`.
 * Property naming has drifted across DBeaver versions, so each field accepts
 * the spellings seen in the wild.
 */
export function readSshTunnel(handlers: unknown): SshTunnelConfig | undefined {
  if (!handlers || typeof handlers !== 'object') {
    return undefined;
  }

  const handler = (handlers as Record<string, unknown>)['ssh_tunnel'];
  if (!handler || typeof handler !== 'object') {
    return undefined;
  }

  const entry = handler as Record<string, unknown>;
  const props = (entry.properties as Record<string, unknown> | undefined) ?? {};

  const read = (...names: string[]): string | undefined => {
    for (const name of names) {
      for (const source of [props, entry]) {
        const value = source[name];
        if (value !== undefined && value !== null && typeof value !== 'object') {
          const str = String(value);
          if (str.length > 0) {
            return str;
          }
        }
      }
    }
    return undefined;
  };

  const host = read('host', 'hostName');
  if (!host) {
    return undefined;
  }

  const portRaw = read('port');
  const port = portRaw ? parseInt(portRaw, 10) : 22;

  return {
    // A handler present but disabled is a tunnel the user turned off, and the
    // connection is then genuinely direct.
    enabled: entry.enabled === true || entry.enabled === 'true',
    host,
    port: Number.isNaN(port) ? 22 : port,
    user: read('userName', 'user', 'username'),
    authType: read('authType', 'auth_type'),
    privateKeyPath: read('keyPath', 'privKeyPath', 'privateKeyPath', 'keyFile', 'privKeyFile'),
    passphrase: read('passphrase', 'keyPassphrase'),
    password: read('password'),
  };
}

export class WorkspaceConfigParser {
  private config: WorkspaceConfig;
  private isNewFormat: boolean = false;

  constructor(config: WorkspaceConfig = {}) {
    const workspacePath = config.workspacePath ?? this.getDefaultWorkspacePath();
    const debug = config.debug ?? false;
    const projectName = config.projectName ?? DEFAULT_PROJECT_NAME;
    this.config = {
      ...config,
      workspacePath,
      debug,
      projectName,
    };

    // Detect which workspace config format is in use (new JSON vs legacy XML)
    this.isNewFormat = this.detectNewFormat();
  }

  private detectNewFormat(): boolean {
    const newFormatPath = path.join(
      this.config.workspacePath!,
      this.config.projectName!,
      '.dbeaver',
      'data-sources.json'
    );
    const oldFormatPath = path.join(
      this.config.workspacePath!,
      '.metadata',
      '.plugins',
      'org.jkiss.dbeaver.core',
      'connections.xml'
    );

    // If new format exists, use it
    if (fs.existsSync(newFormatPath)) {
      return true;
    }

    // If old format exists, use it
    if (fs.existsSync(oldFormatPath)) {
      return false;
    }

    // If neither exists, check for new format directory structure
    const newFormatDir = path.join(
      this.config.workspacePath!,
      this.config.projectName!,
      '.dbeaver'
    );
    const oldFormatDir = path.join(this.config.workspacePath!, '.metadata');

    // Prefer new format if its directory structure exists
    if (fs.existsSync(newFormatDir)) {
      return true;
    }

    // Default to old format if metadata directory exists
    if (fs.existsSync(oldFormatDir)) {
      return false;
    }

    // Default to new format for newer DB client installations
    return true;
  }

  private getDefaultWorkspacePath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();

    switch (platform) {
      case 'win32':
        return path.join(homeDir, 'AppData', 'Roaming', 'DBeaverData', 'workspace6');
      case 'darwin':
        return path.join(homeDir, 'Library', 'DBeaverData', 'workspace6');
      default: // Linux and others
        return path.join(homeDir, '.local', 'share', 'DBeaverData', 'workspace6');
    }
  }

  private getConnectionsFilePath(): string {
    if (this.isNewFormat) {
      return path.join(
        this.config.workspacePath!,
        this.config.projectName!,
        '.dbeaver',
        'data-sources.json'
      );
    } else {
      return path.join(
        this.config.workspacePath!,
        '.metadata',
        '.plugins',
        'org.jkiss.dbeaver.core',
        'connections.xml'
      );
    }
  }

  private getCredentialsFilePath(): string {
    if (this.isNewFormat) {
      return path.join(
        this.config.workspacePath!,
        this.config.projectName!,
        '.dbeaver',
        'credentials-config.json'
      );
    } else {
      return path.join(
        this.config.workspacePath!,
        '.metadata',
        '.plugins',
        'org.jkiss.dbeaver.core',
        'credentials-config.json'
      );
    }
  }

  async parseConnections(): Promise<DatabaseConnection[]> {
    const connectionsFile = this.getConnectionsFilePath();

    if (!fs.existsSync(connectionsFile)) {
      // Try the alternative format if the detected format file doesn't exist
      const alternativeFormat = !this.isNewFormat;
      const alternativeFile = alternativeFormat
        ? path.join(
            this.config.workspacePath!,
            this.config.projectName!,
            '.dbeaver',
            'data-sources.json'
          )
        : path.join(
            this.config.workspacePath!,
            '.metadata',
            '.plugins',
            'org.jkiss.dbeaver.core',
            'connections.xml'
          );

      if (fs.existsSync(alternativeFile)) {
        // Switch to the alternative format and retry
        this.isNewFormat = alternativeFormat;
        return this.parseConnections();
      }

      // Neither format exists - return empty array instead of throwing error
      if (this.config.debug) {
        console.warn(
          `No workspace connections found. Checked:\n- ${connectionsFile}\n- ${alternativeFile}`
        );
      }
      return [];
    }

    try {
      let connections: DatabaseConnection[] = [];

      if (this.isNewFormat) {
        connections = await this.parseNewFormatConnections(connectionsFile);
      } else {
        connections = await this.parseOldFormatConnections(connectionsFile);
      }

      // Load and merge credentials
      await this.loadCredentials(connections);

      return connections;
    } catch (error) {
      throw new Error(`Failed to parse workspace connections: ${error}`);
    }
  }

  private async parseNewFormatConnections(filePath: string): Promise<DatabaseConnection[]> {
    const jsonContent = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(jsonContent);

    const connections: DatabaseConnection[] = [];

    if (!data.connections) {
      return connections;
    }

    for (const [connectionId, connData] of Object.entries(data.connections)) {
      const conn = connData as any;

      const rawDriver = conn.driver || '';
      const url = conn.configuration?.url || '';

      const connection: DatabaseConnection = {
        id: connectionId,
        name: conn.name || connectionId,
        // Custom drivers can carry an opaque id (e.g. a UUID), which no native
        // routing would match. Resolve it to a dialect via provider/URL.
        driver: resolveDriverDialect(rawDriver, conn.provider, url) || conn.provider || '',
        driverId: rawDriver || undefined,
        provider: conn.provider || undefined,
        url: '',
        folder: conn.folder || '',
        description: conn.description || '',
        readonly: conn.readonly === true,
      };

      // Extract properties from the new format
      if (conn.configuration) {
        const config = conn.configuration;
        const props: Record<string, string> = {
          url: config.url || '',
          user: config.user || '',
          host: config.host || '',
          port: config.port ? String(config.port) : '',
          database: config.database || '',
          server: config.server || '',
          ...config,
        };

        connection.properties = props;
        connection.url = config.url || '';
        connection.user = config.user || '';
        connection.host = config.host || config.server || '';
        connection.port = config.port ? parseInt(String(config.port)) : undefined;
        connection.database = config.database || '';

        this.applyUrlEndpoint(connection, props, config.configurationType);
        connection.sshTunnel = readSshTunnel(config.handlers);
      }

      connections.push(connection);
    }

    return connections;
  }

  /**
   * Reconcile a connection's endpoint fields with its JDBC URL.
   *
   * DBeaver connections come in two configuration modes and the mode decides
   * which side is authoritative:
   *
   *  - MANUAL: `host`/`port`/`database` are what the user typed. The URL is
   *    generated from them, so it only fills in fields the config omits.
   *  - URL: the user typed the URL and *that* is the connection. The
   *    host/port/database fields are left at placeholder values - typically
   *    `localhost` - which DBeaver itself never reads. Taking them at face
   *    value is how a remote connection ends up pointed at the local machine.
   *
   * Anything the URL does not carry still falls back to the config fields, so
   * a URL without a database keeps the one recorded alongside it.
   */
  private applyUrlEndpoint(
    connection: DatabaseConnection,
    props: Record<string, string>,
    configurationType?: string
  ): void {
    const fromUrl = parseJdbcUrl(connection.url);
    const urlMode = String(configurationType ?? '').toUpperCase() === 'URL';

    // In URL mode the URL wins, but only where it actually says something -
    // and only if it parsed at all, so an exotic URL we cannot read leaves the
    // recorded fields alone rather than blanking them.
    const urlWins = urlMode && fromUrl.host !== undefined;

    if (urlMode && !urlWins && this.config.debug) {
      console.error(
        `Connection "${connection.name}" is URL-mode but its JDBC URL could not be parsed ` +
          `("${connection.url}"); falling back to the recorded host/port, which DBeaver ` +
          `leaves at a placeholder for URL-mode connections.`
      );
    }

    const set = (field: 'host' | 'database', value: string) => {
      connection[field] = value;
      props[field] = value;
    };

    if (fromUrl.host !== undefined && (urlWins || !connection.host)) {
      set('host', fromUrl.host);
    }
    if (fromUrl.port !== undefined && (urlWins || !connection.port)) {
      connection.port = fromUrl.port;
      props.port = String(fromUrl.port);
    }
    if (fromUrl.database !== undefined && (urlWins || !connection.database)) {
      set('database', fromUrl.database);
    }
  }

  private async parseOldFormatConnections(filePath: string): Promise<DatabaseConnection[]> {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');
    const result = await parseXML(xmlContent);

    return this.extractConnections(result);
  }

  private extractConnections(xmlData: any): DatabaseConnection[] {
    const connections: DatabaseConnection[] = [];

    if (!xmlData.connections || !xmlData.connections.connection) {
      return connections;
    }

    const connectionArray = Array.isArray(xmlData.connections.connection)
      ? xmlData.connections.connection
      : [xmlData.connections.connection];

    for (const conn of connectionArray) {
      // Collect properties first: the JDBC URL feeds driver dialect resolution.
      const properties: Record<string, string> = {};
      if (conn.property) {
        const propArray = Array.isArray(conn.property) ? conn.property : [conn.property];

        for (const prop of propArray) {
          if (prop.$ && prop.$.name && prop.$.value) {
            properties[prop.$.name] = prop.$.value;
          }
        }
      }

      const rawDriver = conn.$.driver || '';
      const provider = conn.$.provider || '';

      const connection: DatabaseConnection = {
        id: conn.$.id || '',
        name: conn.$.name || '',
        driver: resolveDriverDialect(rawDriver, provider, properties.url) || provider,
        driverId: rawDriver || undefined,
        provider: provider || undefined,
        url: '',
        folder: conn.$.folder || '',
        description: conn.$.description || '',
        readonly: conn.$.readonly === 'true',
      };

      if (conn.property) {
        connection.properties = properties;
        connection.url = properties.url || '';
        connection.user = properties.user || '';
        connection.host = properties.host || '';
        connection.port = properties.port ? parseInt(properties.port) : undefined;
        connection.database = properties.database || '';

        this.applyUrlEndpoint(connection, properties, properties.configurationType);
      }

      connections.push(connection);
    }

    return connections;
  }

  async getConnection(connectionId: string): Promise<DatabaseConnection | null> {
    const { baseId, databaseOverride } = parseConnectionId(connectionId);

    let match: DatabaseConnection | null = null;
    try {
      const connections = await this.parseConnections();
      match = connections.find((conn) => conn.id === baseId || conn.name === baseId) || null;
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to get connection ${connectionId}: ${error}`);
      }
      return null;
    }

    if (!match || !databaseOverride) {
      return match;
    }

    // On file-backed engines the database *is* a path, so an override would
    // point the connection at an unrelated file rather than a sibling database.
    // Refuse explicitly instead of opening whatever that resolves to.
    if (isFileBackedDriver(match.driver)) {
      throw new Error(
        `Connection "${match.name}" uses a file-backed engine (${match.driver}), where the ` +
          `database is a file path rather than a name on a server. The "<connection>/<database>" ` +
          `override does not apply - add a separate connection for the other file instead.`
      );
    }

    // Database-override syntax "<id>/<database>": clone the matched connection
    // with the requested database swapped in. The synthetic id ensures pool
    // caches keyed on connection.id stay separated per target database.
    return {
      ...match,
      id: `${match.id}/${databaseOverride}`,
      database: databaseOverride,
      properties: { ...(match.properties || {}), database: databaseOverride },
    };
  }

  async validateConnection(connectionId: string): Promise<boolean> {
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      return false;
    }

    // Basic validation - check if essential properties exist
    return !!(connection.url || (connection.host && connection.driver));
  }

  getWorkspacePath(): string {
    return this.config.workspacePath!;
  }

  async getDriverInfo(driverId: string): Promise<any> {
    if (this.isNewFormat) {
      // New format doesn't have a separate drivers.xml file
      // Driver info is embedded in the data-sources.json
      return null;
    }

    const driversFile = path.join(
      this.config.workspacePath!,
      '.metadata',
      '.plugins',
      'org.jkiss.dbeaver.core',
      'drivers.xml'
    );

    if (!fs.existsSync(driversFile)) {
      return null;
    }

    try {
      const xmlContent = fs.readFileSync(driversFile, 'utf-8');
      const result: any = await parseXML(xmlContent);

      if (!result.drivers || !result.drivers.driver) {
        return null;
      }

      const driverArray = Array.isArray(result.drivers.driver)
        ? result.drivers.driver
        : [result.drivers.driver];

      return driverArray.find((driver: any) => driver.$.id === driverId) || null;
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to parse drivers file: ${error}`);
      }
      return null;
    }
  }

  async getConnectionFolders(): Promise<string[]> {
    const connections = await this.parseConnections();
    const folders = new Set<string>();

    connections.forEach((conn) => {
      if (conn.folder) {
        folders.add(conn.folder);
      }
    });

    return Array.from(folders).sort();
  }

  isWorkspaceValid(): boolean {
    const workspacePath = this.config.workspacePath!;

    if (this.isNewFormat) {
      const newFormatPath = path.join(workspacePath, this.config.projectName!, '.dbeaver');
      return fs.existsSync(workspacePath) && fs.existsSync(newFormatPath);
    } else {
      const metadataPath = path.join(workspacePath, '.metadata');
      return fs.existsSync(workspacePath) && fs.existsSync(metadataPath);
    }
  }

  getDebugInfo(): object {
    return {
      workspacePath: this.config.workspacePath,
      connectionsFile: this.getConnectionsFilePath(),
      connectionsFileExists: fs.existsSync(this.getConnectionsFilePath()),
      credentialsFile: this.getCredentialsFilePath(),
      credentialsFileExists: fs.existsSync(this.getCredentialsFilePath()),
      workspaceValid: this.isWorkspaceValid(),
      isNewFormat: this.isNewFormat,
      platform: os.platform(),
      nodeVersion: process.version,
    };
  }

  /**
   * Load and decrypt credentials from the workspace's credentials-config.json
   */
  private async loadCredentials(connections: DatabaseConnection[]): Promise<void> {
    const credentialsFile = this.getCredentialsFilePath();

    if (!fs.existsSync(credentialsFile)) {
      if (this.config.debug) {
        console.warn(`Credentials file not found: ${credentialsFile}`);
      }
      return;
    }

    try {
      const encryptedData = fs.readFileSync(credentialsFile);
      const decryptedData = this.decryptCredentials(encryptedData);
      const credentials = JSON.parse(decryptedData);

      // Merge credentials into connections
      for (const connection of connections) {
        const connId = connection.id;

        // Look for credentials in the decrypted data
        if (credentials[connId]) {
          const connCreds = credentials[connId];

          // Extract credentials from the nested structure
          if (connCreds['#connection']) {
            const creds = connCreds['#connection'];

            if (creds.user) {
              connection.user = creds.user;
              if (!connection.properties) {
                connection.properties = {};
              }
              connection.properties.user = creds.user;
            }

            if (creds.password) {
              if (!connection.properties) {
                connection.properties = {};
              }
              connection.properties.password = creds.password;
            }
          }

          // Network handlers keep their credentials in a sibling entry rather
          // than under '#connection', so an SSH tunnel's user and password are
          // invisible to anything that only reads the connection's own.
          const tunnelCreds = connCreds['network/ssh_tunnel'];
          if (tunnelCreds && connection.sshTunnel) {
            if (tunnelCreds.user) {
              connection.sshTunnel.user = tunnelCreds.user;
            }
            if (tunnelCreds.password) {
              connection.sshTunnel.password = tunnelCreds.password;
            }
          }
        }
      }

      if (this.config.debug) {
        console.error(`Successfully loaded credentials for ${connections.length} connections`);
      }
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to load credentials: ${error}`);
      }
      // Don't throw - continue without credentials
    }
  }

  /**
   * Decrypt workspace credentials using AES-128-CBC.
   * The local DB client (DBeaver-compatible) uses a hardcoded key and IV for encryption.
   */
  private decryptCredentials(encryptedData: Buffer): string {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', WORKSPACE_AES_KEY, WORKSPACE_AES_IV);
      decipher.setAutoPadding(true);

      // Decrypt entire file, then drop the 16-byte header from the decrypted output
      let decrypted = decipher.update(encryptedData);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      const withoutHeader = decrypted.slice(16);
      return withoutHeader.toString('utf8');
    } catch (error) {
      throw new Error(`Failed to decrypt credentials: ${error}`);
    }
  }
}
