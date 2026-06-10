const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const {
  forwardOut,
  registerConnectionCleanup,
  withActiveConnectionClientRetry,
} = require('./connectionManager.cjs');
const { execRemoteCommandRaw, statRemotePath, validateRemotePath } = require('./remoteConnectionHandlers.cjs');
const {
  isPlainObject,
  quotePowerShellString,
  readBoundedString,
  readIntegerInRange,
} = require('./validation.cjs');
const {
  isLocalConnection,
  runLocalCommand,
  statLocalPath,
} = require('./localConnection.cjs');

let RedisModule = null;
let mysqlModule = null;
let mongoModule = null;
let PostgresClientModule = null;

function getRedisModule() {
  if (!RedisModule) {
    RedisModule = require('ioredis');
  }

  return RedisModule;
}

function getMysqlModule() {
  if (!mysqlModule) {
    mysqlModule = require('mysql2/promise');
  }

  return mysqlModule;
}

function getMongoModule() {
  if (!mongoModule) {
    const mongodb = require('mongodb');
    const EJSON = mongodb.EJSON || mongodb.BSON?.EJSON;

    if (!EJSON) {
      throw new Error('MongoDB EJSON 工具不可用，请检查 mongodb 依赖版本。');
    }

    mongoModule = { MongoClient: mongodb.MongoClient, EJSON };
  }

  return mongoModule;
}

function getPostgresClientModule() {
  if (!PostgresClientModule) {
    PostgresClientModule = require('pg').Client;
  }

  return PostgresClientModule;
}

function registerDatabaseHandlers(registerIpcHandler) {
  function getMongoEjson() {
    return getMongoModule().EJSON;
  }

  function getMongoClient() {
    const { MongoClient } = getMongoModule();

    if (typeof MongoClient !== 'function') {
      throw new Error('MongoDB 客户端不可用，请检查 mongodb 依赖版本。');
    }

    return MongoClient;
  }

  function adaptConnectedSocketStream(stream) {
    if (typeof stream.setNoDelay !== 'function') {
      stream.setNoDelay = () => stream;
    }

    if (typeof stream.setKeepAlive !== 'function') {
      stream.setKeepAlive = () => stream;
    }

    if (typeof stream.connect !== 'function') {
      stream.connect = () => {
        process.nextTick(() => {
          if (!stream.destroyed) {
            stream.emit('connect');
          }
        });
        return stream;
      };
    }

    if (typeof stream.ref !== 'function') {
      stream.ref = () => stream;
    }

    if (typeof stream.unref !== 'function') {
      stream.unref = () => stream;
    }

    return stream;
  }

  // ─── MySQL over SSH tunnel ──────────────────────────────────────────────────

  const activeMysqlConnections = new Map();

  function getMysqlKey(connectionId, mysqlId) {
    return `${connectionId}::${mysqlId}`;
  }

  function createMysqlTunnelStream(client, host, port) {
    return forwardOut(client, host, port);
  }

  async function createMysqlConnection(activeConnection, config) {
    const stream = await createMysqlTunnelStream(activeConnection.client, config.host, config.port);

    try {
      const connection = await getMysqlModule().createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        stream,
        connectTimeout: 15000,
        charset: 'utf8mb4',
      });

      return { connection, transport: stream.shellDeskTransport || 'ssh-tunnel' };
    } catch (error) {
      stream.destroy();
      const relayStderr = stream.shellDeskTransportDetails?.getStderr?.();

      if (relayStderr) {
        throw new Error(`MySQL 连接失败：${relayStderr}`);
      }

      throw error;
    }
  }

  registerIpcHandler('connection:mysql-connect', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) {
      throw new Error('MySQL 连接配置无效。');
    }

    const mysqlHost = readBoundedString(rawConfig.host || '127.0.0.1', 'MySQL 主机', 256);
    const mysqlPort = readIntegerInRange(rawConfig.port, 'MySQL 端口', 1, 65535, 3306);
    const mysqlUser = readBoundedString(rawConfig.user || 'root', 'MySQL 用户名', 128);
    const mysqlPassword = typeof rawConfig.password === 'string' ? rawConfig.password : '';
    const mysqlDatabase = typeof rawConfig.database === 'string' && rawConfig.database
      ? readBoundedString(rawConfig.database, 'MySQL 数据库', 256)
      : undefined;
    const mysqlId = readBoundedString(rawConfig.mysqlId || crypto.randomUUID(), 'MySQL 连接 ID', 128);
    const key = getMysqlKey(connectionId, mysqlId);

    const existing = activeMysqlConnections.get(key);

    if (existing) {
      try {
        await existing.connection.query('SELECT 1');
        return { mysqlId, alreadyConnected: true, transport: existing.transport || 'ssh-tunnel' };
      } catch {
        activeMysqlConnections.delete(key);
        existing.connection.end().catch(() => {});
      }
    }

    const { connection, transport } = await withActiveConnectionClientRetry(connectionId, (activeConnection) => createMysqlConnection(activeConnection, {
      host: mysqlHost,
      user: mysqlUser,
      password: mysqlPassword,
      database: mysqlDatabase,
      port: mysqlPort,
    }));

    activeMysqlConnections.set(key, { connection, connectionId, mysqlId, transport });

    return { mysqlId, transport };
  });

  registerIpcHandler('connection:mysql-disconnect', async (_event, connectionId, rawMysqlId) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (entry) {
      activeMysqlConnections.delete(key);
      await entry.connection.end().catch(() => {});
    }

    return true;
  });

  registerIpcHandler('connection:mysql-databases', async (_event, connectionId, rawMysqlId) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (!entry) {
      throw new Error('MySQL 连接已断开。');
    }

    const [rows] = await entry.connection.query('SHOW DATABASES');
    return rows.map((row) => row.Database || row.database || Object.values(row)[0]);
  });

  registerIpcHandler('connection:mysql-tables', async (_event, connectionId, rawMysqlId, rawDatabase) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (!entry) {
      throw new Error('MySQL 连接已断开。');
    }

    const [rows] = await entry.connection.query('SHOW TABLES FROM ??', [database]);
    return rows.map((row) => Object.values(row)[0]);
  });

  registerIpcHandler('connection:mysql-columns', async (_event, connectionId, rawMysqlId, rawDatabase, rawTable) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const table = readBoundedString(rawTable, '表名', 256);
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (!entry) {
      throw new Error('MySQL 连接已断开。');
    }

    const [rows] = await entry.connection.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [database, table],
    );

    return rows.map((row) => ({
      name: row.COLUMN_NAME,
      type: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      key: row.COLUMN_KEY,
      default: row.COLUMN_DEFAULT,
      extra: row.EXTRA,
      comment: row.COLUMN_COMMENT,
    }));
  });

  registerIpcHandler('connection:mysql-query', async (_event, connectionId, rawMysqlId, rawSql, rawDatabase) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (!entry) {
      throw new Error('MySQL 连接已断开。');
    }

    if (rawDatabase) {
      const database = readBoundedString(rawDatabase, '数据库名', 256);
      await entry.connection.query('USE ??', [database]);
    }

    const [rows, fields] = await entry.connection.query(sql);
    const columnNames = fields ? fields.map((f) => f.name) : [];
    const data = Array.isArray(rows) ? rows : [];
    const affectedRows = typeof rows === 'object' && rows !== null && 'affectedRows' in rows
      ? rows.affectedRows
      : undefined;
    const insertId = typeof rows === 'object' && rows !== null && 'insertId' in rows && rows.insertId
      ? String(rows.insertId)
      : undefined;

    return { columns: columnNames, rows: data, affectedRows, insertId };
  });

  registerIpcHandler('connection:mysql-update-cell', async (_event, connectionId, rawMysqlId, rawDatabase, rawTable, rawPkColumn, rawPkValue, rawColumn, rawNewValue, rawPkColumns, rawPkValues) => {
    const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const table = readBoundedString(rawTable, '表名', 256);
    const column = readBoundedString(rawColumn, '列名', 256);
    const key = getMysqlKey(connectionId, mysqlId);
    const entry = activeMysqlConnections.get(key);

    if (!entry) {
      throw new Error('MySQL 连接已断开。');
    }

    await entry.connection.query('USE ??', [database]);

    let whereClause;
    let whereParams;

    if (Array.isArray(rawPkColumns) && Array.isArray(rawPkValues) && rawPkColumns.length > 0) {
      whereClause = rawPkColumns.map((col) => '?? = ?').join(' AND ');
      whereParams = rawPkColumns.flatMap((col, i) => [col, rawPkValues[i]]);
    } else {
      whereClause = '?? = ?';
      whereParams = [rawPkColumn, rawPkValue];
    }

    const sql = `UPDATE ?? SET ?? = ? WHERE ${whereClause}`;
    const params = [`${database}.${table}`, column, rawNewValue === null ? null : rawNewValue, ...whereParams];
    const [result] = await entry.connection.query(sql, params);

    return { affectedRows: result.affectedRows };
  });

  // ─── ClickHouse over SSH tunnel ────────────────────────────────────────────

  const activeClickHouseConnections = new Map();
  const maxClickHouseResponseBytes = 25 * 1024 * 1024;

  function getClickHouseKey(connectionId, clickhouseId) {
    return `${connectionId}::${clickhouseId}`;
  }

  function quoteClickHouseString(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  function createClickHouseEntry(connectionId, clickhouseId, config) {
    return { connectionId, clickhouseId, config };
  }

  function createClickHouseRequestStream(rawStream, config) {
    const stream = adaptConnectedSocketStream(rawStream);

    if (!config.secure) {
      return stream;
    }

    return tls.connect({
      socket: stream,
      servername: config.host,
      rejectUnauthorized: false,
    });
  }

  function parseClickHouseJsonResponse(text) {
    if (!text.trim()) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
      };
    }

    let payload;

    try {
      payload = JSON.parse(text);
    } catch {
      return {
        columns: ['response'],
        rows: [{ response: text }],
        rowCount: 1,
      };
    }

    const rows = Array.isArray(payload.data)
      ? payload.data.map((row) => (isPlainObject(row) ? row : { value: row }))
      : [];
    const columns = Array.isArray(payload.meta)
      ? payload.meta.map((column) => String(column.name || '')).filter(Boolean)
      : rows.length > 0
        ? Object.keys(rows[0])
        : [];
    const statistics = isPlainObject(payload.statistics)
      ? {
          elapsed: Number(payload.statistics.elapsed) || 0,
          rowsRead: Number(payload.statistics.rows_read) || 0,
          bytesRead: Number(payload.statistics.bytes_read) || 0,
        }
      : undefined;

    return {
      columns,
      rows,
      rowCount: Number.isFinite(Number(payload.rows)) ? Number(payload.rows) : rows.length,
      statistics,
    };
  }

  function formatClickHouseRequestFailure(config, message) {
    const normalizedMessage = String(message || '').trim().replace(/\s+/g, ' ');
    const target = `${config.secure ? 'https' : 'http'}://${config.host}:${config.port}`;

    if (/connection refused|econnrefused/i.test(normalizedMessage)) {
      return `ClickHouse HTTP 接口 ${target} 拒绝连接。请确认远端 ClickHouse 已开启 HTTP 端口（默认 8123，HTTPS 默认 8443），不要填写原生 TCP 端口 9000；如果服务只监听特定地址，请把主机改为实际监听地址。原始错误：${normalizedMessage}`;
    }

    if (/wrong version number|ssl|tls|certificate|eproto/i.test(normalizedMessage)) {
      return `ClickHouse HTTP 接口 ${target} 的 TLS/协议不匹配。请检查 HTTPS / TLS 开关是否和端口一致：普通 HTTP 通常是 8123，HTTPS 通常是 8443。原始错误：${normalizedMessage}`;
    }

    if (/timeout|timed out/i.test(normalizedMessage)) {
      return `ClickHouse HTTP 接口 ${target} 请求超时。请确认端口可从当前 SSH 服务器访问，并缩小查询范围后重试。原始错误：${normalizedMessage}`;
    }

    return `ClickHouse 请求失败（${target}）：${normalizedMessage}`;
  }

  async function sendClickHouseQuery(entry, sql, database) {
    const body = String(sql || '').trim();

    if (!body) {
      throw new Error('ClickHouse SQL 语句不能为空。');
    }

    const config = entry.config;
    const params = new URLSearchParams({
      default_format: 'JSON',
      wait_end_of_query: '1',
    });

    if (database) {
      params.set('database', database);
    }

    return withActiveConnectionClientRetry(entry.connectionId, async (activeConnection) => {
      const rawStream = await forwardOut(activeConnection.client, config.host, config.port);
      const transport = rawStream.shellDeskTransport || 'ssh-tunnel';
      const stream = createClickHouseRequestStream(rawStream, config);
      const requestModule = config.secure ? https : http;

      try {
        const text = await new Promise((resolve, reject) => {
          let responseBytes = 0;
          const chunks = [];
          const request = requestModule.request({
            host: config.host,
            port: config.port,
            method: 'POST',
            path: `/?${params.toString()}`,
            createConnection: () => stream,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
              'X-ClickHouse-User': config.user,
              ...(config.password ? { 'X-ClickHouse-Key': config.password } : {}),
            },
            timeout: 60000,
          }, (response) => {
            response.on('data', (chunk) => {
              responseBytes += chunk.length;

              if (responseBytes > maxClickHouseResponseBytes) {
                request.destroy(new Error('ClickHouse 响应超过 25MB，请缩小查询范围。'));
                return;
              }

              chunks.push(Buffer.from(chunk));
            });

            response.on('end', () => {
              const responseText = Buffer.concat(chunks).toString('utf8');

              if (response.statusCode && response.statusCode >= 400) {
                const responseError = new Error(responseText.trim() || `ClickHouse HTTP ${response.statusCode}`);
                responseError.shellDeskClickHouseHttpError = true;
                reject(responseError);
                return;
              }

              resolve(responseText);
            });
          });

          request.on('timeout', () => request.destroy(new Error('ClickHouse 请求超时。')));
          request.on('error', reject);
          request.end(body);
        });

        return { ...parseClickHouseJsonResponse(text), transport };
      } catch (error) {
        const relayStderr = rawStream.shellDeskTransportDetails?.getStderr?.();

        if (error?.shellDeskClickHouseHttpError) {
          throw error;
        }

        if (relayStderr) {
          throw new Error(formatClickHouseRequestFailure(config, relayStderr));
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        if (/connection refused|econnrefused|wrong version number|ssl|tls|certificate|eproto|timeout|timed out/i.test(errorMessage)) {
          throw new Error(formatClickHouseRequestFailure(config, errorMessage));
        }

        throw error;
      } finally {
        stream.destroy();
        rawStream.destroy();
      }
    });
  }

  function getActiveClickHouseConnection(connectionId, rawClickhouseId) {
    const clickhouseId = readBoundedString(rawClickhouseId, 'ClickHouse 连接 ID', 128);
    const key = getClickHouseKey(connectionId, clickhouseId);
    const entry = activeClickHouseConnections.get(key);

    if (!entry) {
      throw new Error('ClickHouse 连接已断开。');
    }

    return { clickhouseId, entry };
  }

  registerIpcHandler('connection:clickhouse-connect', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) {
      throw new Error('ClickHouse 连接配置无效。');
    }

    const clickhouseHost = readBoundedString(rawConfig.host || '127.0.0.1', 'ClickHouse 主机', 256);
    const clickhousePort = readIntegerInRange(rawConfig.port, 'ClickHouse HTTP 端口', 1, 65535, rawConfig.secure ? 8443 : 8123);
    const clickhouseUser = readBoundedString(rawConfig.user || 'default', 'ClickHouse 用户名', 128);
    const clickhousePassword = typeof rawConfig.password === 'string' ? rawConfig.password : '';
    const clickhouseDatabase = typeof rawConfig.database === 'string' && rawConfig.database
      ? readBoundedString(rawConfig.database, 'ClickHouse 数据库', 256)
      : undefined;
    const clickhouseId = readBoundedString(rawConfig.clickhouseId || crypto.randomUUID(), 'ClickHouse 连接 ID', 128);
    const clickhouseSecure = Boolean(rawConfig.secure);
    const key = getClickHouseKey(connectionId, clickhouseId);
    const existing = activeClickHouseConnections.get(key);

    if (existing) {
      try {
        const result = await sendClickHouseQuery(existing, 'SELECT 1 AS ok', clickhouseDatabase);
        return { clickhouseId, alreadyConnected: true, transport: result.transport || 'ssh-tunnel' };
      } catch {
        activeClickHouseConnections.delete(key);
      }
    }

    const entry = createClickHouseEntry(connectionId, clickhouseId, {
      host: clickhouseHost,
      port: clickhousePort,
      user: clickhouseUser,
      password: clickhousePassword,
      database: clickhouseDatabase,
      secure: clickhouseSecure,
    });
    const result = await sendClickHouseQuery(entry, 'SELECT 1 AS ok', clickhouseDatabase);

    activeClickHouseConnections.set(key, entry);

    return { clickhouseId, transport: result.transport || 'ssh-tunnel' };
  });

  registerIpcHandler('connection:clickhouse-disconnect', async (_event, connectionId, rawClickhouseId) => {
    const clickhouseId = readBoundedString(rawClickhouseId, 'ClickHouse 连接 ID', 128);
    const key = getClickHouseKey(connectionId, clickhouseId);
    activeClickHouseConnections.delete(key);
    return true;
  });

  registerIpcHandler('connection:clickhouse-databases', async (_event, connectionId, rawClickhouseId) => {
    const { entry } = getActiveClickHouseConnection(connectionId, rawClickhouseId);
    const result = await sendClickHouseQuery(entry, 'SELECT name FROM system.databases ORDER BY name');
    return result.rows.map((row) => row.name).filter((name) => typeof name === 'string');
  });

  registerIpcHandler('connection:clickhouse-tables', async (_event, connectionId, rawClickhouseId, rawDatabase) => {
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const { entry } = getActiveClickHouseConnection(connectionId, rawClickhouseId);
    const result = await sendClickHouseQuery(
      entry,
      [
        'SELECT name, engine, total_rows AS totalRows, total_bytes AS totalBytes',
        'FROM system.tables',
        `WHERE database = ${quoteClickHouseString(database)}`,
        'ORDER BY name',
      ].join(' '),
    );

    return result.rows.map((row) => ({
      name: String(row.name || ''),
      engine: String(row.engine || ''),
      totalRows: row.totalRows === null || row.totalRows === undefined ? null : Number(row.totalRows),
      totalBytes: row.totalBytes === null || row.totalBytes === undefined ? null : Number(row.totalBytes),
    })).filter((table) => table.name);
  });

  registerIpcHandler('connection:clickhouse-columns', async (_event, connectionId, rawClickhouseId, rawDatabase, rawTable) => {
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const table = readBoundedString(rawTable, '表名', 256);
    const { entry } = getActiveClickHouseConnection(connectionId, rawClickhouseId);
    const result = await sendClickHouseQuery(
      entry,
      [
        'SELECT name, type, default_kind AS defaultKind, default_expression AS defaultExpression, comment,',
        'is_in_primary_key AS isPrimaryKey, is_in_sorting_key AS isSortingKey',
        'FROM system.columns',
        `WHERE database = ${quoteClickHouseString(database)} AND table = ${quoteClickHouseString(table)}`,
        'ORDER BY position',
      ].join(' '),
    );

    return result.rows.map((row) => ({
      name: String(row.name || ''),
      type: String(row.type || ''),
      defaultKind: String(row.defaultKind || ''),
      defaultExpression: String(row.defaultExpression || ''),
      comment: String(row.comment || ''),
      isPrimaryKey: Boolean(Number(row.isPrimaryKey || 0)),
      isSortingKey: Boolean(Number(row.isSortingKey || 0)),
    })).filter((column) => column.name);
  });

  registerIpcHandler('connection:clickhouse-query', async (_event, connectionId, rawClickhouseId, rawSql, rawDatabase) => {
    const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
    const database = rawDatabase ? readBoundedString(rawDatabase, '数据库名', 256) : undefined;
    const { entry } = getActiveClickHouseConnection(connectionId, rawClickhouseId);
    const result = await sendClickHouseQuery(entry, sql, database);

    return {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      statistics: result.statistics,
    };
  });

  // ─── MongoDB over SSH tunnel ───────────────────────────────────────────────

  const activeMongoConnections = new Map();

  function getMongoKey(connectionId, mongoId) {
    return `${connectionId}::${mongoId}`;
  }

  function createTcpTunnel(client, remoteHost, remotePort) {
    return new Promise((resolve, reject) => {
      const localHost = '127.0.0.1';
      const server = net.createServer((localSocket) => {
        localSocket.on('error', () => undefined);

        forwardOut(client, remoteHost, remotePort).then((remoteStream) => {
          if (localSocket.destroyed) {
            remoteStream.destroy();
            return;
          }

          localSocket.pipe(remoteStream).pipe(localSocket);
          remoteStream.on('error', () => localSocket.destroy());
          remoteStream.on('close', () => localSocket.destroy());
          localSocket.on('close', () => remoteStream.destroy());
        }).catch(() => {
          localSocket.destroy();
        });
      });

      server.listen(0, localHost, () => {
        const address = server.address();
        const localPort = typeof address === 'object' && address ? address.port : 0;
        resolve({ server, localPort, localHost });
      });
      server.on('error', reject);
    });
  }

  function getActiveMongoConnection(connectionId, rawMongoId) {
    const mongoId = readBoundedString(rawMongoId, 'MongoDB 连接 ID', 128);
    const key = getMongoKey(connectionId, mongoId);
    const entry = activeMongoConnections.get(key);

    if (!entry) {
      throw new Error('MongoDB 连接已断开。');
    }

    return { mongoId, entry };
  }

  function parseMongoJson(rawValue, label, fallback) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return fallback;
    }

    const text = readBoundedString(rawValue, label, 1024 * 1024, { required: false, rejectLineBreaks: false });

    if (!text.trim()) {
      return fallback;
    }

    const parsed = getMongoEjson().parse(text, { relaxed: true });

    if (!isPlainObject(parsed)) {
      throw new Error(`${label}必须是 JSON 对象。`);
    }

    return parsed;
  }

  function serializeMongoValue(value) {
    const EJSON = getMongoEjson();
    return EJSON.parse(EJSON.stringify(value, { relaxed: false }));
  }

  registerIpcHandler('connection:mongo-connect', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) {
      throw new Error('MongoDB 连接配置无效。');
    }

    const mongoHost = readBoundedString(rawConfig.host || '127.0.0.1', 'MongoDB 主机', 256);
    const mongoPort = readIntegerInRange(rawConfig.port, 'MongoDB 端口', 1, 65535, 27017);
    const mongoUser = typeof rawConfig.username === 'string' && rawConfig.username.trim()
      ? readBoundedString(rawConfig.username, 'MongoDB 用户名', 128)
      : '';
    const mongoPassword = typeof rawConfig.password === 'string' ? rawConfig.password : '';
    const authSource = typeof rawConfig.authSource === 'string' && rawConfig.authSource.trim()
      ? readBoundedString(rawConfig.authSource, 'MongoDB 认证库', 128)
      : 'admin';
    const mongoId = readBoundedString(rawConfig.mongoId || crypto.randomUUID(), 'MongoDB 连接 ID', 128);
    const key = getMongoKey(connectionId, mongoId);
    const existing = activeMongoConnections.get(key);

    if (existing) {
      try {
        await existing.client.db('admin').command({ ping: 1 });
        return { mongoId, alreadyConnected: true };
      } catch {
        activeMongoConnections.delete(key);
        existing.client.close().catch(() => {});
        existing.tunnelServer.close();
      }
    }

    const { server: tunnelServer, localPort } = await withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      createTcpTunnel(activeConnection.client, mongoHost, mongoPort));
    const MongoClient = getMongoClient();
    const client = new MongoClient(`mongodb://127.0.0.1:${localPort}`, {
      auth: mongoUser ? { username: mongoUser, password: mongoPassword } : undefined,
      authSource: mongoUser ? authSource : undefined,
      connectTimeoutMS: 15000,
      directConnection: true,
      maxPoolSize: 4,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 15000,
    });

    try {
      await client.connect();
      await client.db(authSource).command({ ping: 1 });
    } catch (error) {
      await client.close().catch(() => {});
      tunnelServer.close();
      throw error;
    }

    activeMongoConnections.set(key, { client, connectionId, mongoId, tunnelServer });

    return { mongoId };
  });

  registerIpcHandler('connection:mongo-disconnect', async (_event, connectionId, rawMongoId) => {
    const mongoId = readBoundedString(rawMongoId, 'MongoDB 连接 ID', 128);
    const key = getMongoKey(connectionId, mongoId);
    const entry = activeMongoConnections.get(key);

    if (entry) {
      activeMongoConnections.delete(key);
      await entry.client.close().catch(() => {});
      entry.tunnelServer.close();
    }

    return true;
  });

  registerIpcHandler('connection:mongo-databases', async (_event, connectionId, rawMongoId) => {
    const { entry } = getActiveMongoConnection(connectionId, rawMongoId);
    const result = await entry.client.db().admin().listDatabases();

    return result.databases
      .map((database) => ({
        name: database.name,
        sizeOnDisk: database.sizeOnDisk,
        empty: Boolean(database.empty),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  registerIpcHandler('connection:mongo-collections', async (_event, connectionId, rawMongoId, rawDatabase) => {
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const { entry } = getActiveMongoConnection(connectionId, rawMongoId);
    const collections = await entry.client.db(database).listCollections({}, { nameOnly: false }).toArray();

    return collections
      .map((collection) => ({
        name: collection.name,
        type: collection.type || 'collection',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  registerIpcHandler('connection:mongo-indexes', async (_event, connectionId, rawMongoId, rawDatabase, rawCollection) => {
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    const collection = readBoundedString(rawCollection, '集合名', 256);
    const { entry } = getActiveMongoConnection(connectionId, rawMongoId);
    const indexes = await entry.client.db(database).collection(collection).indexes();

    return indexes.map((index) => ({
      name: index.name || '',
      key: serializeMongoValue(index.key || {}),
      unique: Boolean(index.unique),
      sparse: Boolean(index.sparse),
      expireAfterSeconds: typeof index.expireAfterSeconds === 'number' ? index.expireAfterSeconds : undefined,
    }));
  });

  registerIpcHandler('connection:mongo-query', async (_event, connectionId, rawMongoId, rawRequest) => {
    if (!isPlainObject(rawRequest)) {
      throw new Error('MongoDB 查询参数无效。');
    }

    const database = readBoundedString(rawRequest.database, '数据库名', 256);
    const collection = readBoundedString(rawRequest.collection, '集合名', 256);
    const filter = parseMongoJson(rawRequest.filter, 'Filter', {});
    const projection = parseMongoJson(rawRequest.projection, 'Projection', undefined);
    const sort = parseMongoJson(rawRequest.sort, 'Sort', undefined);
    const limit = readIntegerInRange(rawRequest.limit, 'Limit', 1, 1000, 100);
    const { entry } = getActiveMongoConnection(connectionId, rawMongoId);
    const cursor = entry.client.db(database).collection(collection).find(filter, projection ? { projection } : undefined);

    if (sort) {
      cursor.sort(sort);
    }

    const documents = await cursor.limit(limit).toArray();

    return {
      documents: serializeMongoValue(documents),
      count: documents.length,
      limit,
    };
  });

  // ─── PostgreSQL over SSH tunnel ─────────────────────────────────────────────

  const activePostgresConnections = new Map();

  function getPostgresKey(connectionId, postgresId) {
    return `${connectionId}::${postgresId}`;
  }

  function getActivePostgresConnection(connectionId, rawPostgresId) {
    const postgresId = readBoundedString(rawPostgresId, 'PostgreSQL 连接 ID', 128);
    const key = getPostgresKey(connectionId, postgresId);
    const entry = activePostgresConnections.get(key);

    if (!entry) {
      throw new Error('PostgreSQL 连接已断开。');
    }

    return { postgresId, entry };
  }

  registerIpcHandler('connection:postgres-connect', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) {
      throw new Error('PostgreSQL 连接配置无效。');
    }

    const postgresHost = readBoundedString(rawConfig.host || '127.0.0.1', 'PostgreSQL 主机', 256);
    const postgresPort = readIntegerInRange(rawConfig.port, 'PostgreSQL 端口', 1, 65535, 5432);
    const postgresUser = readBoundedString(rawConfig.user || 'postgres', 'PostgreSQL 用户名', 128);
    const postgresPassword = typeof rawConfig.password === 'string' ? rawConfig.password : '';
    const postgresDatabase = readBoundedString(rawConfig.database || 'postgres', 'PostgreSQL 数据库', 256);
    const postgresId = readBoundedString(rawConfig.postgresId || crypto.randomUUID(), 'PostgreSQL 连接 ID', 128);
    const key = getPostgresKey(connectionId, postgresId);
    const existing = activePostgresConnections.get(key);

    if (existing) {
      try {
        await existing.client.query('SELECT 1');
        return { postgresId, alreadyConnected: true };
      } catch {
        activePostgresConnections.delete(key);
        existing.client.end().catch(() => {});
      }
    }

    const stream = adaptConnectedSocketStream(await withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      forwardOut(activeConnection.client, postgresHost, postgresPort)));
    const PostgresClient = getPostgresClientModule();
    const client = new PostgresClient({
      host: postgresHost,
      port: postgresPort,
      user: postgresUser,
      password: postgresPassword,
      database: postgresDatabase,
      stream,
      connectionTimeoutMillis: 15000,
    });

    await client.connect();
    activePostgresConnections.set(key, { client, connectionId, postgresId });

    return { postgresId };
  });

  registerIpcHandler('connection:postgres-disconnect', async (_event, connectionId, rawPostgresId) => {
    const postgresId = readBoundedString(rawPostgresId, 'PostgreSQL 连接 ID', 128);
    const key = getPostgresKey(connectionId, postgresId);
    const entry = activePostgresConnections.get(key);

    if (entry) {
      activePostgresConnections.delete(key);
      await entry.client.end().catch(() => {});
    }

    return true;
  });

  registerIpcHandler('connection:postgres-databases', async (_event, connectionId, rawPostgresId) => {
    const { entry } = getActivePostgresConnection(connectionId, rawPostgresId);
    const result = await entry.client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
    );

    return result.rows.map((row) => row.datname);
  });

  registerIpcHandler('connection:postgres-schemas', async (_event, connectionId, rawPostgresId) => {
    const { entry } = getActivePostgresConnection(connectionId, rawPostgresId);
    const result = await entry.client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') ORDER BY schema_name",
    );

    return result.rows.map((row) => row.schema_name);
  });

  registerIpcHandler('connection:postgres-tables', async (_event, connectionId, rawPostgresId, rawSchema) => {
    const schema = readBoundedString(rawSchema, 'Schema 名称', 256);
    const { entry } = getActivePostgresConnection(connectionId, rawPostgresId);
    const result = await entry.client.query(
      'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema],
    );

    return result.rows.map((row) => ({
      schema: row.table_schema,
      name: row.table_name,
      type: row.table_type,
    }));
  });

  registerIpcHandler('connection:postgres-columns', async (_event, connectionId, rawPostgresId, rawSchema, rawTable) => {
    const schema = readBoundedString(rawSchema, 'Schema 名称', 256);
    const table = readBoundedString(rawTable, '表名', 256);
    const { entry } = getActivePostgresConnection(connectionId, rawPostgresId);
    const result = await entry.client.query(
      `
  SELECT
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    EXISTS (
      SELECT 1
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = c.table_schema
        AND tc.table_name = c.table_name
        AND kcu.column_name = c.column_name
    ) AS is_primary_key
  FROM information_schema.columns c
  WHERE c.table_schema = $1 AND c.table_name = $2
  ORDER BY c.ordinal_position
  `,
      [schema, table],
    );

    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      isPrimaryKey: Boolean(row.is_primary_key),
    }));
  });

  registerIpcHandler('connection:postgres-query', async (_event, connectionId, rawPostgresId, rawSql) => {
    const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
    const { entry } = getActivePostgresConnection(connectionId, rawPostgresId);
    const result = await entry.client.query(sql);

    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows,
      rowCount: result.rowCount ?? undefined,
    };
  });

  // ─── Redis over SSH tunnel ──────────────────────────────────────────────────

  const activeRedisConnections = new Map();
  const redisValuePreviewLimit = 200;

  function getRedisKey(connectionId, redisId) {
    return `${connectionId}::${redisId}`;
  }

  function getActiveRedisConnection(connectionId, rawRedisId) {
    const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
    const key = getRedisKey(connectionId, redisId);
    const entry = activeRedisConnections.get(key);

    if (!entry) {
      throw new Error('Redis 连接已断开。');
    }

    return { redisId, entry };
  }

  function getRedisSizeCommand(type) {
    switch (type) {
      case 'string': return 'strlen';
      case 'hash': return 'hlen';
      case 'list': return 'llen';
      case 'set': return 'scard';
      case 'zset': return 'zcard';
      case 'stream': return 'xlen';
      default: return '';
    }
  }

  async function createRedisKeySummaries(connection, keyNames) {
    if (!keyNames.length) {
      return [];
    }

    const scannedAt = new Date().toISOString();
    const metaPipeline = connection.pipeline();

    for (const keyName of keyNames) {
      metaPipeline.type(keyName);
      metaPipeline.ttl(keyName);
    }

    const metaResults = await metaPipeline.exec();
    const summaries = keyNames.map((name, index) => {
      const typeResult = metaResults?.[index * 2] ?? [];
      const ttlResult = metaResults?.[index * 2 + 1] ?? [];

      return {
        name,
        type: typeResult[0] ? 'unknown' : (typeResult[1] || 'none'),
        ttl: ttlResult[0] ? -2 : Number(ttlResult[1]),
        scannedAt,
      };
    });

    const sizePipeline = connection.pipeline();
    const sizeJobs = [];

    summaries.forEach((summary, index) => {
      const command = getRedisSizeCommand(summary.type);

      if (command) {
        sizePipeline.call(command, summary.name);
        sizeJobs.push(index);
      }
    });

    if (sizeJobs.length) {
      const sizeResults = await sizePipeline.exec();

      sizeJobs.forEach((summaryIndex, resultIndex) => {
        const [error, value] = sizeResults?.[resultIndex] ?? [];

        if (!error && value !== undefined && value !== null && Number.isFinite(Number(value))) {
          summaries[summaryIndex].size = Number(value);
        }
      });
    }

    return summaries;
  }

  function normalizeRedisScanOptions(rawOptions) {
    const options = isPlainObject(rawOptions) ? rawOptions : {};
    const cursor = readBoundedString(String(options.cursor ?? '0'), '扫描游标', 64, { required: false }) || '0';
    const pattern = readBoundedString(
      typeof options.pattern === 'string' && options.pattern.trim() ? options.pattern : '*',
      '键匹配模式',
      512,
      { required: false },
    ) || '*';
    const count = readIntegerInRange(options.count, '扫描数量', 10, 2000, 300);

    return { cursor, pattern, count };
  }

  function createRedisTunnel(client, redisHost, redisPort) {
    return new Promise((resolve, reject) => {
      const localHost = '127.0.0.1';
      const server = net.createServer((localSocket) => {
        localSocket.on('error', () => undefined);

        forwardOut(client, redisHost, redisPort).then((remoteStream) => {
          if (localSocket.destroyed) {
            remoteStream.destroy();
            return;
          }

          localSocket.pipe(remoteStream).pipe(localSocket);
          remoteStream.on('error', () => localSocket.destroy());
          remoteStream.on('close', () => localSocket.destroy());
          localSocket.on('close', () => remoteStream.destroy());
        }).catch(() => {
          localSocket.destroy();
        });
      });
      server.listen(0, localHost, () => {
        const address = server.address();
        const localPort = typeof address === 'object' && address ? address.port : 0;
        resolve({ server, localPort, localHost });
      });
      server.on('error', reject);
    });
  }

  registerIpcHandler('connection:redis-connect', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) { throw new Error('Redis 连接配置无效。'); }
    const redisHost = readBoundedString(rawConfig.host || '127.0.0.1', 'Redis 主机', 256);
    const redisPort = readIntegerInRange(rawConfig.port, 'Redis 端口', 1, 65535, 6379);
    const redisPassword = typeof rawConfig.password === 'string' ? rawConfig.password : undefined;
    const redisDb = typeof rawConfig.db === 'number' ? rawConfig.db : (parseInt(rawConfig.db, 10) || 0);
    const redisId = readBoundedString(rawConfig.redisId || crypto.randomUUID(), 'Redis 连接 ID', 128);
    const key = getRedisKey(connectionId, redisId);
    const existing = activeRedisConnections.get(key);
    if (existing) {
      try { await existing.connection.ping(); return { redisId, alreadyConnected: true }; }
      catch { existing.tunnelServer.close(); activeRedisConnections.delete(key); }
    }
    const { server: tunnelServer, localPort } = await withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      createRedisTunnel(activeConnection.client, redisHost, redisPort));
    const Redis = getRedisModule();
    const redis = new Redis({
      host: '127.0.0.1', port: localPort, password: redisPassword, db: redisDb,
      lazyConnect: true, connectTimeout: 15000, maxRetriesPerRequest: 1,
    });
    await redis.connect();
    activeRedisConnections.set(key, { connection: redis, connectionId, redisId, tunnelServer });
    return { redisId };
  });

  registerIpcHandler('connection:redis-disconnect', async (_event, connectionId, rawRedisId) => {
    const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
    const key = getRedisKey(connectionId, redisId);
    const entry = activeRedisConnections.get(key);
    if (entry) { activeRedisConnections.delete(key); entry.connection.disconnect(); entry.tunnelServer.close(); }
    return true;
  });

  registerIpcHandler('connection:redis-scan', async (_event, connectionId, rawRedisId, rawOptions) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const { cursor, pattern, count } = normalizeRedisScanOptions(rawOptions);
    const [nextCursor, batch] = await entry.connection.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    const keys = await createRedisKeySummaries(entry.connection, Array.isArray(batch) ? batch : []);

    keys.sort((a, b) => a.name.localeCompare(b.name));

    return {
      cursor: nextCursor,
      complete: nextCursor === '0',
      pattern,
      scannedAt: new Date().toISOString(),
      keys,
    };
  });

  registerIpcHandler('connection:redis-keys', async (_event, connectionId, rawRedisId, rawPattern) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const pattern = typeof rawPattern === 'string' ? rawPattern : '*';
    const allKeys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await entry.connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      allKeys.push(...batch);
    } while (cursor !== '0');
    const result = [];
    const pipeline = entry.connection.pipeline();
    for (const k of allKeys) { pipeline.type(k); pipeline.ttl(k); }
    const pipelineResults = await pipeline.exec();
    for (let i = 0; i < allKeys.length; i++) {
      const typeErr = pipelineResults[i * 2][0];
      const typeVal = pipelineResults[i * 2][1];
      const ttlErr = pipelineResults[i * 2 + 1][0];
      const ttlVal = pipelineResults[i * 2 + 1][1];
      result.push({ name: allKeys[i], type: typeErr ? 'unknown' : (typeVal || 'none'), ttl: ttlErr ? -2 : ttlVal });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  });

  registerIpcHandler('connection:redis-get-value', async (_event, connectionId, rawRedisId, rawKey) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const key = readBoundedString(rawKey, '键名', 1024);
    const type = await entry.connection.type(key);
    const ttl = await entry.connection.ttl(key);
    const sizeCommand = getRedisSizeCommand(type);
    const size = sizeCommand ? Number(await entry.connection.call(sizeCommand, key)) : undefined;
    let count = size;
    let truncated = false;
    let value;
    switch (type) {
      case 'string': value = await entry.connection.get(key); break;
      case 'hash': {
        const [cursor, entries] = await entry.connection.hscan(key, '0', 'COUNT', redisValuePreviewLimit);
        value = {};
        for (let index = 0; index < entries.length; index += 2) {
          value[entries[index]] = entries[index + 1] ?? '';
        }
        truncated = cursor !== '0' || (count !== undefined && Object.keys(value).length < count);
        break;
      }
      case 'list':
        value = await entry.connection.lrange(key, 0, redisValuePreviewLimit - 1);
        truncated = count !== undefined && count > redisValuePreviewLimit;
        break;
      case 'set': {
        const [cursor, members] = await entry.connection.sscan(key, '0', 'COUNT', redisValuePreviewLimit);
        value = members;
        truncated = cursor !== '0' || (count !== undefined && members.length < count);
        break;
      }
      case 'zset': {
        const rawItems = await entry.connection.zrange(key, 0, redisValuePreviewLimit - 1, 'WITHSCORES');
        value = [];
        for (let index = 0; index < rawItems.length; index += 2) {
          value.push({ member: rawItems[index], score: Number(rawItems[index + 1]) });
        }
        truncated = count !== undefined && count > redisValuePreviewLimit;
        break;
      }
      case 'stream':
        value = await entry.connection.xrange(key, '-', '+', 'COUNT', Math.min(redisValuePreviewLimit, 100));
        truncated = count !== undefined && count > 100;
        break;
      case 'none': throw new Error(`键 "${key}" 不存在。`);
      default:
        value = null;
        count = undefined;
        break;
    }
    return { type, value, ttl, size, count, previewLimit: redisValuePreviewLimit, truncated };
  });

  registerIpcHandler('connection:redis-set-value', async (_event, connectionId, rawRedisId, rawKey, rawValue, rawType) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const key = readBoundedString(rawKey, '键名', 1024);
    const type = typeof rawType === 'string' ? rawType : 'string';
    const ttlMs = await entry.connection.pttl(key);
    const pipeline = entry.connection.pipeline();
    pipeline.del(key);
    switch (type) {
      case 'string': pipeline.set(key, String(rawValue)); break;
      case 'hash': {
        if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
          pipeline.hset(key, rawValue);
        } else {
          throw new Error('Hash 值必须是 JSON 对象。');
        }
        break;
      }
      case 'list': {
        if (Array.isArray(rawValue) && rawValue.length > 0) {
          pipeline.rpush(key, ...rawValue);
        } else if (!Array.isArray(rawValue)) {
          throw new Error('List 值必须是 JSON 数组。');
        }
        break;
      }
      case 'set': {
        if (Array.isArray(rawValue) && rawValue.length > 0) {
          pipeline.sadd(key, ...rawValue);
        } else if (!Array.isArray(rawValue)) {
          throw new Error('Set 值必须是 JSON 数组。');
        }
        break;
      }
      case 'zset': {
        if (Array.isArray(rawValue)) {
          const zsetArgs = [];
          for (let i = 0; i < rawValue.length; i++) {
            const item = rawValue[i];
            if (typeof item === 'object' && item !== null && 'member' in item && 'score' in item) {
              zsetArgs.push(item.score, item.member);
            } else if (i % 2 === 0 && i + 1 < rawValue.length) {
              zsetArgs.push(rawValue[i + 1], rawValue[i]);
              i++;
            }
          }
          if (zsetArgs.length > 0) pipeline.zadd(key, ...zsetArgs);
        } else {
          throw new Error('ZSet 值必须是 JSON 数组。');
        }
        break;
      }
      default:
        throw new Error(`暂不支持保存 ${type} 类型。`);
    }
    if (ttlMs > 0) {
      pipeline.pexpire(key, ttlMs);
    }
    await pipeline.exec();
    return true;
  });

  registerIpcHandler('connection:redis-delete-key', async (_event, connectionId, rawRedisId, rawKey) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const key = readBoundedString(rawKey, '键名', 1024);
    await entry.connection.del(key);
    return true;
  });

  registerIpcHandler('connection:redis-command', async (_event, connectionId, rawRedisId, rawCommand, rawArgs) => {
    const { entry } = getActiveRedisConnection(connectionId, rawRedisId);
    const command = readBoundedString(rawCommand, '命令', 256);
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const result = await entry.connection.call(command, ...args);
    return result;
  });


  const activeSqliteSessions = new Map();

  function getSqliteKey(connectionId, sqliteId) {
    return `${connectionId}::${sqliteId}`;
  }

  function getActiveSqliteSession(connectionId, rawSqliteId) {
    const sqliteId = readBoundedString(rawSqliteId, 'SQLite 会话 ID', 128);
    const key = getSqliteKey(connectionId, sqliteId);
    const entry = activeSqliteSessions.get(key);

    if (!entry) {
      throw new Error('SQLite 会话已关闭。');
    }

    return { sqliteId, entry };
  }

  function escapeShellSingleQuotedArg(arg) {
    return `'${String(arg).replace(/'/g, "'\\''")}'`;
  }

  function quoteSqliteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
  }

  function quoteSqliteLiteral(value) {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === 'boolean') {
      return value ? '1' : '0';
    }

    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function isPermissionDeniedError(error) {
    const message = String(error?.message ?? error ?? '');
    const code = error?.code;

    return code === 3 ||
      code === 'EACCES' ||
      /permission denied|access denied|eacces|eperm/i.test(message);
  }

  function readSqlitePrivilegeOptions(rawOptions) {
    if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
      return {};
    }

    const options = {};

    if (typeof rawOptions.sudoPassword === 'string') {
      options.sudoPassword = readBoundedString(rawOptions.sudoPassword, 'sudo 密码', 4096, {
        required: false,
        trim: false,
        rejectLineBreaks: true,
      });
    }

    return options;
  }

  function hasSudoPasswordOption(options = {}) {
    return Object.prototype.hasOwnProperty.call(options, 'sudoPassword');
  }

  function getSqlitePrivilegeFromConnection(activeConnection, options = {}) {
    if (activeConnection.displayHost.systemType === 'windows') {
      return null;
    }

    if (hasSudoPasswordOption(options)) {
      return {
        mode: 'sudo',
        password: options.sudoPassword ?? '',
      };
    }

    const privilegeConfig = activeConnection.privilegeConfig;

    if (privilegeConfig?.mode === 'su-root' && privilegeConfig.rootPassword) {
      return {
        mode: 'su-root',
        password: privilegeConfig.rootPassword,
      };
    }

    return null;
  }

  function getSqlitePrivilegeFromSession(entry, options = {}) {
    if (entry.systemType === 'windows') {
      return null;
    }

    if (hasSudoPasswordOption(options)) {
      return {
        mode: 'sudo',
        password: options.sudoPassword ?? '',
      };
    }

    if (entry.privilege) {
      return entry.privilege;
    }

    if (entry.privilegeConfig?.mode === 'su-root' && entry.privilegeConfig.rootPassword) {
      return {
        mode: 'su-root',
        password: entry.privilegeConfig.rootPassword,
      };
    }

    return null;
  }

  function isSudoPrivilegeModeFromConnection(activeConnection) {
    return activeConnection.displayHost.systemType !== 'windows' &&
      activeConnection.privilegeConfig?.mode === 'sudo';
  }

  function isSudoPrivilegeModeFromSession(entry) {
    return entry.systemType !== 'windows' &&
      entry.privilegeConfig?.mode === 'sudo';
  }

  function createPrivilegeStdin(privilege, stdin = '') {
    return privilege ? `${privilege.password ?? ''}\n${stdin}` : stdin;
  }

  function stripSuRootPasswordPrompt(stderr) {
    return String(stderr || '').replace(/^\s*(?:password|密码|口令)[:：]\s*/i, '');
  }

  function normalizePrivilegeResult(result, privilege) {
    if (privilege?.mode !== 'su-root') {
      return result;
    }

    return {
      ...result,
      stderr: stripSuRootPasswordPrompt(result.stderr),
    };
  }

  function isSudoAuthenticationFailure(result) {
    return /sorry, try again|incorrect password|authentication failure|authentication failed/i.test(result.stderr);
  }

  function isSuAuthenticationFailure(result) {
    return /su:.*authentication failure|authentication failure|authentication failed|incorrect password|su:.*permission denied|su:.*denied|密码.*错误|认证失败|鉴定故障/i.test(result.stderr);
  }

  function isSuPasswordInputFailure(result) {
    return /must be run from a terminal|cannot open session|no tty|conversation error|authentication token manipulation/i.test(result.stderr);
  }

  function createPrivilegedShellCommand(script, args, privilege = null) {
    const baseCommand = [
      'sh',
      '-c',
      escapeShellSingleQuotedArg(script),
      'sh',
      ...args.map((arg) => escapeShellSingleQuotedArg(String(arg))),
    ].join(' ');

    if (privilege?.mode === 'sudo') {
      return [
        'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
        'IFS= read -r _shelldesk_sudo_password || true;',
        `${baseCommand};`,
        'else',
        'IFS= read -r _shelldesk_sudo_password || exit 43;',
        'printf "%s\\n" "$_shelldesk_sudo_password" | sudo -S -p \'\' -v &&',
        `sudo -n ${baseCommand};`,
        'fi',
      ].join(' ');
    }

    if (privilege?.mode === 'su-root') {
      return [
        'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
        'IFS= read -r _shelldesk_root_password || true;',
        `${baseCommand};`,
        'else',
        `su - root -c ${escapeShellSingleQuotedArg(baseCommand)};`,
        'fi',
      ].join(' ');
    }

    return baseCommand;
  }

  function createElevationRequiredError(result, fallbackMessage = '当前账号需要 sudo 密码才能访问该 SQLite 数据库。') {
    const detail = result?.stderr?.trim?.() || result?.message || fallbackMessage;
    if (String(detail).startsWith('SHELLDESK_ELEVATION_REQUIRED:')) {
      return new Error(detail);
    }
    return new Error(`SHELLDESK_ELEVATION_REQUIRED:${detail}`);
  }

  function createElevationAuthFailedError(result) {
    const detail = result.stderr.trim() || 'sudo 密码验证失败或当前账号没有提权权限。';
    return new Error(`SHELLDESK_ELEVATION_AUTH_FAILED:${detail}`);
  }

  function createSuRootElevationFailedError(result) {
    const detail = result.stderr.trim();
    const message = detail
      ? `root 密码验证失败，或当前账号不能通过 su root 提权：${detail}`
      : 'root 密码验证失败，或当前账号不能通过 su root 提权。';
    return new Error(`SHELLDESK_SU_ROOT_AUTH_FAILED:${message}`);
  }

  function createSuRootElevationUnsupportedError(result) {
    const detail = result.stderr.trim();
    const message = detail
      ? `远程系统无法在非交互 SSH 命令中使用 su root：${detail}`
      : '远程系统无法在非交互 SSH 命令中使用 su root。';
    return new Error(`SHELLDESK_SU_ROOT_UNSUPPORTED:${message}`);
  }

  function assertSqlitePrivilegeResult(result, privilege) {
    if (result.code === 0 || !privilege) {
      return;
    }

    if (privilege.mode === 'sudo' && isSudoAuthenticationFailure(result)) {
      throw createElevationAuthFailedError(result);
    }

    if (privilege.mode === 'su-root') {
      if (isSuPasswordInputFailure(result)) {
        throw createSuRootElevationUnsupportedError(result);
      }

      if (isSuAuthenticationFailure(result)) {
        throw createSuRootElevationFailedError(result);
      }
    }
  }

  function isSqliteElevationCandidate(errorOrResult) {
    const message = [
      errorOrResult?.message,
      errorOrResult?.stderr,
      errorOrResult?.stdout,
      String(errorOrResult ?? ''),
    ].filter(Boolean).join('\n');

    return /permission denied|access denied|eacces|eperm|unable to open database file|attempt to write a readonly database|readonly database|authorization denied|password is required|a terminal is required|no tty present|askpass/i.test(message);
  }

  function parseSqliteCsv(csvText) {
    const normalizedText = String(csvText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (!normalizedText.trim()) {
      return { columns: [], rows: [] };
    }

    const parsedRows = [];
    let row = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < normalizedText.length; index++) {
      const ch = normalizedText[index];

      if (inQuotes) {
        if (ch === '"') {
          if (normalizedText[index + 1] === '"') {
            current += '"';
            index++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current);
        current = '';
      } else if (ch === '\n') {
        row.push(current);
        parsedRows.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }

    if (current || row.length) {
      row.push(current);
      parsedRows.push(row);
    }

    if (parsedRows.length === 0) return { columns: [], rows: [] };

    const columns = parsedRows[0].map((column) => column.trim());
    const rows = parsedRows.slice(1).map((values) => {
      const nextRow = {};

      for (let index = 0; index < columns.length; index++) {
        nextRow[columns[index]] = values[index] !== undefined ? values[index] : null;
      }

      return nextRow;
    });

    return { columns, rows };
  }

  function parseSqliteNameList(stdout) {
    const parsed = parseSqliteCsv(stdout);
    return parsed.rows.map((row) => row.name || row.Name || '').filter(Boolean);
  }

  function createPowerShellStdinCommand(script) {
    const utf8Prelude = `
try {
$__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $__shelldeskUtf8
[Console]::OutputEncoding = $__shelldeskUtf8
$OutputEncoding = $__shelldeskUtf8
} catch {}
try { chcp.com 65001 > $null } catch {}
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
`;

    return {
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command -',
      stdin: `${utf8Prelude}\n${script}`,
    };
  }

  function createWindowsSqliteCommand(filePath, command) {
    return createPowerShellStdinCommand(`
$DatabasePath = ${quotePowerShellString(filePath.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1'))}
$Sql = ${quotePowerShellString(command)}
$SqliteCommand = Get-Command sqlite3 -ErrorAction SilentlyContinue

if (-not $SqliteCommand) {
  [Console]::Error.WriteLine("远端 Windows 未找到 sqlite3。请安装 SQLite CLI 并加入 PATH 后重试。可用命令：winget install SQLite.SQLite")
  exit 127
}

& $SqliteCommand.Source -csv -header $DatabasePath $Sql
exit $LASTEXITCODE
`);
  }

  function createUnixSqliteCommand(filePath, command, privilege = null) {
    if (!privilege) {
      const escapedPath = escapeShellSingleQuotedArg(filePath);
      const escapedCommand = escapeShellSingleQuotedArg(command);
      return { command: `sqlite3 -csv -header ${escapedPath} ${escapedCommand}`, stdin: '' };
    }

    const sqliteScript = [
      'if ! command -v sqlite3 >/dev/null 2>&1; then',
      '  printf "%s\\n" "远端 Linux 未找到 sqlite3。请安装 SQLite CLI 后重试。" >&2',
      '  exit 127',
      'fi',
      'exec sqlite3 -csv -header "$1" "$2"',
    ].join('\n');

    return {
      command: createPrivilegedShellCommand(sqliteScript, [filePath, command], privilege),
      stdin: createPrivilegeStdin(privilege),
    };
  }

  async function execSqliteOnRemote(client, systemType, filePath, command, privilege = null, options = {}) {
    const commandInput = systemType === 'windows'
      ? createWindowsSqliteCommand(filePath, command)
      : createUnixSqliteCommand(filePath, command, privilege);
    const result = await execRemoteCommandRaw(client, commandInput.command, commandInput.stdin);
    const normalizedResult = normalizePrivilegeResult(result, privilege);

    if (normalizedResult.code !== 0) {
      assertSqlitePrivilegeResult(normalizedResult, privilege);

      if (!privilege && options.canPromptForSudo && isSqliteElevationCandidate(normalizedResult)) {
        throw createElevationRequiredError(normalizedResult);
      }

      throw new Error(normalizedResult.stderr || normalizedResult.stdout || `sqlite3 返回码 ${normalizedResult.code}`);
    }

    return normalizedResult.stdout;
  }

  async function execSqliteOnLocal(systemType, filePath, command) {
    const commandInput = systemType === 'windows'
      ? createWindowsSqliteCommand(filePath, command)
      : createUnixSqliteCommand(filePath, command);
    const result = await runLocalCommand(commandInput.command, commandInput.stdin);

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `sqlite3 返回码 ${result.code}`);
    }

    return result.stdout;
  }

  async function assertRemoteSqliteFile(client, systemType, filePath, privilege = null) {
    if (systemType === 'windows' || !privilege) {
      const stat = await statRemotePath(client, filePath);

      if (stat.type !== 'file') {
        throw new Error('请选择可读取的 SQLite 文件。');
      }

      return;
    }

    const statScript = [
      'if [ ! -e "$1" ]; then',
      '  printf "%s\\n" "SQLite 文件不存在。" >&2',
      '  exit 2',
      'fi',
      'if [ ! -f "$1" ]; then',
      '  printf "%s\\n" "请选择可读取的 SQLite 文件。" >&2',
      '  exit 3',
      'fi',
    ].join('\n');
    const result = normalizePrivilegeResult(
      await execRemoteCommandRaw(
        client,
        createPrivilegedShellCommand(statScript, [filePath], privilege),
        createPrivilegeStdin(privilege),
      ),
      privilege,
    );

    if (result.code !== 0) {
      assertSqlitePrivilegeResult(result, privilege);
      throw new Error(result.stderr || result.stdout || `SQLite 文件检查失败，退出码 ${result.code}`);
    }
  }

  async function openSqliteOnConnection(activeConnection, filePath, options = {}) {
    const systemType = activeConnection.displayHost.systemType;
    if (isLocalConnection(activeConnection)) {
      const stat = await statLocalPath(filePath);
      if (stat.type !== 'file') {
        throw new Error('请选择可读取的 SQLite 文件。');
      }

      await execSqliteOnLocal(systemType, filePath, 'PRAGMA schema_version');
      return { activeConnection, privilege: null };
    }

    const explicitSudoPrivilege = hasSudoPasswordOption(options)
      ? getSqlitePrivilegeFromConnection(activeConnection, options)
      : null;

    if (explicitSudoPrivilege) {
      await assertRemoteSqliteFile(activeConnection.client, systemType, filePath, explicitSudoPrivilege);
      await execSqliteOnRemote(activeConnection.client, systemType, filePath, 'PRAGMA schema_version', explicitSudoPrivilege);
      return { activeConnection, privilege: explicitSudoPrivilege };
    }

    try {
      await assertRemoteSqliteFile(activeConnection.client, systemType, filePath);
      await execSqliteOnRemote(activeConnection.client, systemType, filePath, 'PRAGMA schema_version');
      return { activeConnection, privilege: null };
    } catch (error) {
      if (systemType === 'windows') {
        throw error;
      }

      const configuredPrivilege = getSqlitePrivilegeFromConnection(activeConnection, options);

      if (configuredPrivilege) {
        await assertRemoteSqliteFile(activeConnection.client, systemType, filePath, configuredPrivilege);
        await execSqliteOnRemote(activeConnection.client, systemType, filePath, 'PRAGMA schema_version', configuredPrivilege);
        return { activeConnection, privilege: configuredPrivilege };
      }

      if (isSudoPrivilegeModeFromConnection(activeConnection) && (isPermissionDeniedError(error) || isSqliteElevationCandidate(error))) {
        throw createElevationRequiredError(error, '需要 sudo 密码才能打开该 SQLite 数据库。');
      }

      throw error;
    }
  }

  async function execSqliteForSession(entry, rawOptions, sql) {
    const options = readSqlitePrivilegeOptions(rawOptions);
    if (entry.kind === 'local') {
      return execSqliteOnLocal(entry.systemType, entry.filePath, sql);
    }

    const explicitSudoPrivilege = hasSudoPasswordOption(options)
      ? getSqlitePrivilegeFromSession(entry, options)
      : null;
    const initialPrivilege = explicitSudoPrivilege || entry.privilege || null;

    try {
      const stdout = await execSqliteOnRemote(
        entry.client,
        entry.systemType,
        entry.filePath,
        sql,
        initialPrivilege,
        { canPromptForSudo: isSudoPrivilegeModeFromSession(entry) && !initialPrivilege },
      );

      if (explicitSudoPrivilege) {
        entry.privilege = explicitSudoPrivilege;
      }

      return stdout;
    } catch (error) {
      if (entry.systemType === 'windows' || explicitSudoPrivilege || !isSqliteElevationCandidate(error)) {
        throw error;
      }

      const configuredPrivilege = getSqlitePrivilegeFromSession(entry, options);

      if (configuredPrivilege && configuredPrivilege !== initialPrivilege) {
        const stdout = await execSqliteOnRemote(
          entry.client,
          entry.systemType,
          entry.filePath,
          sql,
          configuredPrivilege,
        );
        entry.privilege = configuredPrivilege;
        return stdout;
      }

      if (isSudoPrivilegeModeFromSession(entry)) {
        throw createElevationRequiredError(error, '需要 sudo 密码才能访问该 SQLite 数据库。');
      }

      throw error;
    }
  }

  registerIpcHandler('connection:sqlite-open', async (_event, connectionId, rawFilePath, rawOptions) => {
    const filePath = validateRemotePath(rawFilePath);
    if (filePath === '.' || filePath === '/') {
      throw new Error('无效的 SQLite 文件路径。');
    }
    const options = readSqlitePrivilegeOptions(rawOptions);
    const { activeConnection, privilege } = await withActiveConnectionClientRetry(connectionId, (connection) =>
      openSqliteOnConnection(connection, filePath, options));
    const sqliteId = crypto.randomUUID();
    const key = getSqliteKey(connectionId, sqliteId);
    activeSqliteSessions.set(key, {
      connectionId,
      sqliteId,
      filePath,
      client: activeConnection.client,
      kind: activeConnection.kind || 'ssh',
      systemType: activeConnection.displayHost.systemType,
      privilege,
      privilegeConfig: activeConnection.privilegeConfig ?? null,
    });
    return { sqliteId, filePath };
  });

  registerIpcHandler('connection:sqlite-close', async (_event, connectionId, rawSqliteId) => {
    const sqliteId = readBoundedString(rawSqliteId, 'SQLite 会话 ID', 128);
    const key = getSqliteKey(connectionId, sqliteId);
    activeSqliteSessions.delete(key);
    return true;
  });

  registerIpcHandler('connection:sqlite-tables', async (_event, connectionId, rawSqliteId, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const stdout = await execSqliteForSession(entry, rawOptions, 'SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name');
    return parseSqliteNameList(stdout);
  });

  function parseSqliteObjectRows(stdout) {
    return parseSqliteCsv(stdout).rows.map((row) => ({
      type: row.type || '',
      name: row.name || '',
      tableName: row.tableName || row.tbl_name || '',
      sql: row.sql || '',
    })).filter((item) => item.type && item.name);
  }

  registerIpcHandler('connection:sqlite-objects', async (_event, connectionId, rawSqliteId, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const stdout = await execSqliteForSession(
      entry,
      rawOptions,
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name",
    );

    return parseSqliteObjectRows(stdout);
  });

  registerIpcHandler('connection:sqlite-columns', async (_event, connectionId, rawSqliteId, rawTable, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const table = readBoundedString(rawTable, '表名', 256);
    const stdout = await execSqliteForSession(entry, rawOptions, `PRAGMA table_info(${quoteSqliteLiteral(table)})`);
    const parsed = parseSqliteCsv(stdout);
    return parsed.rows.map((row) => ({
      name: row.name || row.Name || '',
      type: row.type || row.Type || '',
      nullable: row.notnull === '0' || row['notnull'] === '0',
      pk: row.pk === '1' || row.Pk === '1',
      defaultValue: row.dflt_value || row['dflt_value'] || null,
    }));
  });

  registerIpcHandler('connection:sqlite-schema', async (_event, connectionId, rawSqliteId, rawObjectType, rawObjectName, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const objectType = readBoundedString(rawObjectType, '对象类型', 32);
    const objectName = readBoundedString(rawObjectName, '对象名', 256);
    const stdout = await execSqliteForSession(
      entry,
      rawOptions,
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = ${quoteSqliteLiteral(objectType)} AND name = ${quoteSqliteLiteral(objectName)} LIMIT 1`,
    );
    const [schema] = parseSqliteObjectRows(stdout);

    if (!schema) {
      throw new Error('未找到 SQLite 对象。');
    }

    return schema;
  });

  registerIpcHandler('connection:sqlite-query', async (_event, connectionId, rawSqliteId, rawSql, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
    const stdout = await execSqliteForSession(entry, rawOptions, sql);
    const parsed = parseSqliteCsv(stdout);
    return { columns: parsed.columns, rows: parsed.rows };
  });

  registerIpcHandler('connection:sqlite-update-cell', async (_event, connectionId, rawSqliteId, rawTable, rawColumn, rawNewValue, rawTarget, rawOptions) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const table = readBoundedString(rawTable, '表名', 256);
    const column = readBoundedString(rawColumn, '列名', 256);
    const target = isPlainObject(rawTarget) ? rawTarget : {};
    let whereClause = '';

    if (Array.isArray(target.pkColumns) && Array.isArray(target.pkValues) && target.pkColumns.length > 0 && target.pkColumns.length === target.pkValues.length) {
      whereClause = target.pkColumns.map((rawPkColumn, index) => {
        const pkColumn = readBoundedString(String(rawPkColumn), '主键列名', 256);
        return `${quoteSqliteIdentifier(pkColumn)} = ${quoteSqliteLiteral(target.pkValues[index])}`;
      }).join(' AND ');
    } else if (target.rowid !== undefined && target.rowid !== null) {
      whereClause = `rowid = ${quoteSqliteLiteral(target.rowid)}`;
    }

    if (!whereClause) {
      throw new Error('无法定位要更新的 SQLite 行。');
    }

    const sql = [
      'BEGIN IMMEDIATE;',
      `UPDATE ${quoteSqliteIdentifier(table)} SET ${quoteSqliteIdentifier(column)} = ${quoteSqliteLiteral(rawNewValue)} WHERE ${whereClause};`,
      'SELECT changes() AS affectedRows;',
      'COMMIT;',
    ].join(' ');
    const stdout = await execSqliteForSession(entry, rawOptions, sql);
    const parsed = parseSqliteCsv(stdout);
    const affectedRows = Number(parsed.rows[0]?.affectedRows ?? 0);

    return { affectedRows };
  });

  registerConnectionCleanup(async (connectionId) => {
    for (const [key, entry] of activeMysqlConnections) {
      if (entry.connectionId === connectionId) {
        activeMysqlConnections.delete(key);
        entry.connection.end().catch(() => {});
      }
    }

    for (const [key, entry] of activePostgresConnections) {
      if (entry.connectionId === connectionId) {
        activePostgresConnections.delete(key);
        entry.client.end().catch(() => {});
      }
    }

    for (const [key, entry] of activeClickHouseConnections) {
      if (entry.connectionId === connectionId) {
        activeClickHouseConnections.delete(key);
      }
    }

    for (const [key, entry] of activeMongoConnections) {
      if (entry.connectionId === connectionId) {
        activeMongoConnections.delete(key);
        entry.client.close().catch(() => {});
        entry.tunnelServer.close();
      }
    }

    for (const [key, entry] of activeRedisConnections) {
      if (entry.connectionId === connectionId) {
        activeRedisConnections.delete(key);
        entry.connection.disconnect();
        entry.tunnelServer.close();
      }
    }

    for (const [key, entry] of activeSqliteSessions) {
      if (entry.connectionId === connectionId) {
        activeSqliteSessions.delete(key);
      }
    }
  });
}

module.exports = { registerDatabaseHandlers };
