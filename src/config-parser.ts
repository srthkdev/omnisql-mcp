import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import crypto from 'crypto';
import { DatabaseConnection, WorkspaceConfig } from './types.js';
import { resolveDriverDialect, parseJdbcUrl, parseConnectionId } from './utils.js';

const parseXML = promisify(parseString);

// The local DB client (DBeaver-compatible) uses these hardcoded values for password encryption
const WORKSPACE_AES_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');
const WORKSPACE_AES_IV = Buffer.alloc(16, 0);

// Default project/workspace folder name used by the local DB client (DBeaver-compatible)
const DEFAULT_PROJECT_NAME = 'General';

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

        // Backfill anything the config omits but the JDBC URL carries. Custom
        // drivers sometimes record only the URL.
        const fromUrl = parseJdbcUrl(connection.url);
        if (!connection.host && fromUrl.host) {
          connection.host = fromUrl.host;
          props.host = fromUrl.host;
        }
        if (!connection.port && fromUrl.port) {
          connection.port = fromUrl.port;
          props.port = String(fromUrl.port);
        }
        if (!connection.database && fromUrl.database) {
          connection.database = fromUrl.database;
          props.database = fromUrl.database;
        }
      }

      connections.push(connection);
    }

    return connections;
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

        const fromUrl = parseJdbcUrl(connection.url);
        if (!connection.host && fromUrl.host) {
          connection.host = fromUrl.host;
          connection.properties.host = fromUrl.host;
        }
        if (!connection.port && fromUrl.port) {
          connection.port = fromUrl.port;
          connection.properties.port = String(fromUrl.port);
        }
        if (!connection.database && fromUrl.database) {
          connection.database = fromUrl.database;
          connection.properties.database = fromUrl.database;
        }
      }

      connections.push(connection);
    }

    return connections;
  }

  async getConnection(connectionId: string): Promise<DatabaseConnection | null> {
    try {
      const { baseId, databaseOverride } = parseConnectionId(connectionId);
      const connections = await this.parseConnections();
      const match = connections.find((conn) => conn.id === baseId || conn.name === baseId) || null;

      if (!match || !databaseOverride) {
        return match;
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
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to get connection ${connectionId}: ${error}`);
      }
      return null;
    }
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
