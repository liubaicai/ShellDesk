const crypto = require('node:crypto');
const net = require('node:net');
const Redis = require('ioredis');
const mysql = require('mysql2/promise');
const mongodb = require('mongodb');
const { MongoClient } = mongodb;
const EJSON = mongodb.EJSON || mongodb.BSON?.EJSON;
const { Client: PostgresClient } = require('pg');
const { forwardOut, getActiveConnection, registerConnectionCleanup } = require('./connectionManager.cjs');
const { execRemoteCommandRaw, statRemotePath, validateRemotePath } = require('./remoteConnectionHandlers.cjs');
const { isPlainObject, readBoundedString, readIntegerInRange } = require('./validation.cjs');

function registerDatabaseHandlers(registerIpcHandler) {
  if (!EJSON) {
    throw new Error('MongoDB EJSON 工具不可用，请检查 mongodb 依赖版本。');
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
      const connection = await mysql.createConnection({
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
    const activeConnection = getActiveConnection(connectionId);

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

    const { connection, transport } = await createMysqlConnection(activeConnection, {
      host: mysqlHost,
      user: mysqlUser,
      password: mysqlPassword,
      database: mysqlDatabase,
      port: mysqlPort,
    });

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

  // ─── MongoDB over SSH tunnel ───────────────────────────────────────────────

  const activeMongoConnections = new Map();

  function getMongoKey(connectionId, mongoId) {
    return `${connectionId}::${mongoId}`;
  }

  function createTcpTunnel(client, remoteHost, remotePort) {
    return new Promise((resolve, reject) => {
      const localPort = Math.floor(Math.random() * 50000) + 10000;
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

      server.listen(localPort, localHost, () => {
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

    const parsed = EJSON.parse(text, { relaxed: true });

    if (!isPlainObject(parsed)) {
      throw new Error(`${label}必须是 JSON 对象。`);
    }

    return parsed;
  }

  function serializeMongoValue(value) {
    return EJSON.parse(EJSON.stringify(value, { relaxed: false }));
  }

  registerIpcHandler('connection:mongo-connect', async (_event, connectionId, rawConfig) => {
    const activeConnection = getActiveConnection(connectionId);

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

    const { server: tunnelServer, localPort } = await createTcpTunnel(activeConnection.client, mongoHost, mongoPort);
    const client = new MongoClient(`mongodb://127.0.0.1:${localPort}`, {
      auth: mongoUser ? { username: mongoUser, password: mongoPassword } : undefined,
      authSource: mongoUser ? authSource : undefined,
      connectTimeoutMS: 15000,
      directConnection: true,
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
    const activeConnection = getActiveConnection(connectionId);

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

    const stream = adaptConnectedSocketStream(await forwardOut(activeConnection.client, postgresHost, postgresPort));
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
      const localPort = Math.floor(Math.random() * 50000) + 10000;
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
      server.listen(localPort, localHost, () => {
        resolve({ server, localPort, localHost });
      });
      server.on('error', reject);
    });
  }

  registerIpcHandler('connection:redis-connect', async (_event, connectionId, rawConfig) => {
    const activeConnection = getActiveConnection(connectionId);
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
    const { server: tunnelServer, localPort } = await createRedisTunnel(activeConnection.client, redisHost, redisPort);
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

  async function execSqliteOnRemote(client, filePath, command) {
    const escapedPath = escapeShellSingleQuotedArg(filePath);
    const escapedCommand = escapeShellSingleQuotedArg(command);
    const fullCommand = `sqlite3 -csv -header ${escapedPath} ${escapedCommand}`;
    const result = await execRemoteCommandRaw(client, fullCommand);
    if (result.code !== 0 && result.stderr) {
      throw new Error(result.stderr || `sqlite3 返回码 ${result.code}`);
    }
    return result.stdout;
  }

  registerIpcHandler('connection:sqlite-open', async (_event, connectionId, rawFilePath) => {
    const activeConnection = getActiveConnection(connectionId);
    const filePath = validateRemotePath(rawFilePath);
    if (filePath === '.' || filePath === '/') {
      throw new Error('无效的 SQLite 文件路径。');
    }
    const stat = await statRemotePath(activeConnection.client, filePath);
    if (stat.type !== 'file') {
      throw new Error('请选择可读取的 SQLite 文件。');
    }
    await execSqliteOnRemote(activeConnection.client, filePath, 'PRAGMA schema_version');
    const sqliteId = crypto.randomUUID();
    const key = getSqliteKey(connectionId, sqliteId);
    activeSqliteSessions.set(key, { connectionId, sqliteId, filePath, client: activeConnection.client });
    return { sqliteId, filePath };
  });

  registerIpcHandler('connection:sqlite-close', async (_event, connectionId, rawSqliteId) => {
    const sqliteId = readBoundedString(rawSqliteId, 'SQLite 会话 ID', 128);
    const key = getSqliteKey(connectionId, sqliteId);
    activeSqliteSessions.delete(key);
    return true;
  });

  registerIpcHandler('connection:sqlite-tables', async (_event, connectionId, rawSqliteId) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const stdout = await execSqliteOnRemote(entry.client, entry.filePath, 'SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name');
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

  registerIpcHandler('connection:sqlite-objects', async (_event, connectionId, rawSqliteId) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const stdout = await execSqliteOnRemote(
      entry.client,
      entry.filePath,
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name",
    );

    return parseSqliteObjectRows(stdout);
  });

  registerIpcHandler('connection:sqlite-columns', async (_event, connectionId, rawSqliteId, rawTable) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const table = readBoundedString(rawTable, '表名', 256);
    const stdout = await execSqliteOnRemote(entry.client, entry.filePath, `PRAGMA table_info(${quoteSqliteLiteral(table)})`);
    const parsed = parseSqliteCsv(stdout);
    return parsed.rows.map((row) => ({
      name: row.name || row.Name || '',
      type: row.type || row.Type || '',
      nullable: row.notnull === '0' || row['notnull'] === '0',
      pk: row.pk === '1' || row.Pk === '1',
      defaultValue: row.dflt_value || row['dflt_value'] || null,
    }));
  });

  registerIpcHandler('connection:sqlite-schema', async (_event, connectionId, rawSqliteId, rawObjectType, rawObjectName) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const objectType = readBoundedString(rawObjectType, '对象类型', 32);
    const objectName = readBoundedString(rawObjectName, '对象名', 256);
    const stdout = await execSqliteOnRemote(
      entry.client,
      entry.filePath,
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = ${quoteSqliteLiteral(objectType)} AND name = ${quoteSqliteLiteral(objectName)} LIMIT 1`,
    );
    const [schema] = parseSqliteObjectRows(stdout);

    if (!schema) {
      throw new Error('未找到 SQLite 对象。');
    }

    return schema;
  });

  registerIpcHandler('connection:sqlite-query', async (_event, connectionId, rawSqliteId, rawSql) => {
    const { entry } = getActiveSqliteSession(connectionId, rawSqliteId);
    const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
    const stdout = await execSqliteOnRemote(entry.client, entry.filePath, sql);
    const parsed = parseSqliteCsv(stdout);
    return { columns: parsed.columns, rows: parsed.rows };
  });

  registerIpcHandler('connection:sqlite-update-cell', async (_event, connectionId, rawSqliteId, rawTable, rawColumn, rawNewValue, rawTarget) => {
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
    const stdout = await execSqliteOnRemote(entry.client, entry.filePath, sql);
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
