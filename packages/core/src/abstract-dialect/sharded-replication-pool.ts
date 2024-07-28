import type { TimeoutError } from 'sequelize-pool';
import { Pool } from 'sequelize-pool';
import type { Class } from 'type-fest';
import { logger } from '../utils/logger.js';
import type {
  AcquireConnectionOptions,
  BaseReplicationPool,
  ConnectionType,
  ReplicationPoolOptions,
} from './base-replication-pool.js';

import type {
  ReplicationPoolDestroyOptions,
  ReplicationPoolGetPoolOptions,
  ReplicationPoolReleaseOptions,
} from './replication-pool.js';

type ShardValue = `read:${string}` | `write:${string}`;

export interface ShardedReplicationPoolConfig<
  Connection extends object,
  ConnectionOptions extends object,
> {
  shards: Array<ShardConfig<Connection, ConnectionOptions>>;
  pool: ReplicationPoolOptions;

  // TODO: move this option to sequelize-pool so it applies to sub-pools as well
  timeoutErrorClass?: Class<Error>;

  connect(options: ConnectionOptions): Promise<Connection>;

  disconnect(connection: Connection): Promise<void>;

  validate(connection: Connection): boolean;

  beforeAcquire?(options: AcquireConnectionOptions): Promise<void>;
  afterAcquire?(connection: Connection, options: AcquireConnectionOptions): Promise<void>;
}

type ShardedReplicationPoolAcquireOptions = AcquireConnectionOptions & ShardedObject;

type ShardedReplicationPoolReleaseOptions<Connection extends object> =
  ReplicationPoolReleaseOptions<Connection> & ShardedObject;

type ShardedReplicationPoolDestroyOptions<Connection extends object> =
  ReplicationPoolDestroyOptions<Connection> & ShardedObject;

type ShardedReplicationPoolGetPoolOptions = ReplicationPoolGetPoolOptions & ShardedObject;

const debug = logger.debugContext('pool');

const owningPools = new WeakMap<object, ShardValue>();

function shardValueToTuple(shardValue: ShardValue): [string, ConnectionType] {
  const [type, shardId] = shardValue.split(':');

  return [shardId, type as ConnectionType];
}

export interface ShardedObject extends Object {
  shardId?: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ShardConfig<Connection extends object, ConnectionOptions extends object> {
  shardId: string;
  readConfig: readonly ConnectionOptions[] | null;
  writeConfig: ConnectionOptions;
}

export class ShardedReplicationPool<
  ShardedConnection extends ShardedObject,
  ShardedConnectionOptions extends ShardedObject,
> implements BaseReplicationPool<ShardedConnection>
{
  readonly read = new Map<string, Pool<ShardedConnection> | null>();
  readonly write = new Map<string, Pool<ShardedConnection>>();
  timeoutErrorClass: Class<TimeoutError> | undefined;
  beforeAcquire: ((options: AcquireConnectionOptions) => Promise<void>) | undefined;
  afterAcquire:
    | ((connection: ShardedConnection, options: AcquireConnectionOptions) => Promise<void>)
    | undefined;

  constructor(config: ShardedReplicationPoolConfig<ShardedConnection, ShardedConnectionOptions>) {
    const { connect, disconnect, validate, shards } = config;

    for (const shard of shards) {
      const { readConfig, writeConfig, shardId } = shard;
      if (!readConfig || readConfig.length === 0) {
        // no replication, the write pool will always be used instead

        this.read.set(shard.shardId, null);
      } else {
        let reads = 0;
        const pool = new Pool({
          name: 'sequelize:read',
          create: async () => {
            // round robin config
            const nextRead = reads++ % readConfig.length;
            const connectionOptions = readConfig[nextRead];
            connectionOptions.shardId = shardId;
            const connection = await connect(connectionOptions);

            owningPools.set(connection, `read:${shardId}`);

            return connection;
          },
          destroy: disconnect,
          validate,
          max: config.pool.max,
          min: config.pool.min,
          acquireTimeoutMillis: config.pool.acquire,
          idleTimeoutMillis: config.pool.idle,
          reapIntervalMillis: config.pool.evict,
          maxUses: config.pool.maxUses,
        });

        this.read.set(shardId, pool);
      }

      const write = new Pool({
        name: 'sequelize:write',
        create: async () => {
          writeConfig.shardId = shardId;
          const connection = await connect(writeConfig);

          owningPools.set(connection, `write:${shardId}`);

          return connection;
        },
        destroy: disconnect,
        validate,
        max: config.pool.max,
        min: config.pool.min,
        acquireTimeoutMillis: config.pool.acquire,
        idleTimeoutMillis: config.pool.idle,
        reapIntervalMillis: config.pool.evict,
        maxUses: config.pool.maxUses,
      });

      this.write.set(shardId, write);
    }
  }

  async acquire(options: ShardedReplicationPoolAcquireOptions): Promise<ShardedConnection> {
    if (options?.type !== 'read' && options?.type !== 'write') {
      throw new Error(`Expected queryType to be either read or write. Received ${options.type}`);
    }

    const pool = this.getPool({
      shardId: options.shardId,
      poolType: options.type,
      useMaster: options.useMaster!,
    });

    if (pool == null) {
      throw new Error(`No ${options.type} pool found for shard ${options.shardId}`);
    }

    const connection = await pool.acquire();
    connection.shardId = options.shardId;

    return connection;
  }

  release({ connection }: ShardedReplicationPoolReleaseOptions<ShardedConnection>): void {
    const shardValue = owningPools.get(connection);
    if (!shardValue) {
      throw new Error('Unable to determine to which sharded pool the connection belongs');
    }

    const [shardId, type] = shardValueToTuple(shardValue);

    this.getPool({ shardId, poolType: type, useMaster: false })?.release(connection);
  }

  async destroy({
    connection,
  }: ShardedReplicationPoolDestroyOptions<ShardedConnection>): Promise<void> {
    const shardValue = owningPools.get(connection);
    if (!shardValue) {
      throw new Error('Unable to determine to which sharded pool the connection belongs');
    }

    const [shardId, type] = shardValueToTuple(shardValue);

    await this.getPool({ shardId, poolType: type, useMaster: false })?.destroy(connection);
    debug('connection destroy');
  }

  async destroyAllNow(): Promise<void> {
    const promises = [];
    for (const pool of this.read.values()) {
      promises.push(pool?.destroyAllNow());
    }

    for (const pool of this.write.values()) {
      promises.push(pool.destroyAllNow());
    }

    await Promise.all(promises);

    debug('all connections destroyed');
  }

  async drain(): Promise<void> {
    const promises = [];
    for (const pool of this.read.values()) {
      promises.push(pool?.drain());
    }

    for (const pool of this.write.values()) {
      promises.push(pool.drain());
    }

    await Promise.all(promises);

    debug('all connections destroyed');
  }

  getPool({
    shardId,
    poolType,
    useMaster,
  }: ShardedReplicationPoolGetPoolOptions): Pool<ShardedConnection> | null {
    if (poolType === 'read' && this.read != null && !useMaster) {
      return this.read.get(shardId!) ?? null;
    }

    return this.write.get(shardId!) ?? null;
  }

  shardSize(shardId: string): number {
    return (
      this.getPool({ shardId, poolType: 'read', useMaster: false })?.size ??
      0 + (this.getPool({ shardId, poolType: 'write', useMaster: true })?.size ?? 0)
    );
  }

  shardAvailable(shardId: string): number {
    return (
      this.getPool({ shardId, poolType: 'read', useMaster: false })?.available ??
      0 + (this.getPool({ shardId, poolType: 'write', useMaster: true })?.available ?? 0)
    );
  }

  shardUsing(shardId: string): number {
    return (
      this.getPool({ shardId, poolType: 'read', useMaster: false })?.using ??
      0 + (this.getPool({ shardId, poolType: 'write', useMaster: true })?.using ?? 0)
    );
  }

  shardWaiting(shardId: string): number {
    return (
      this.getPool({ shardId, poolType: 'read', useMaster: false })?.waiting ??
      0 + (this.getPool({ shardId, poolType: 'write', useMaster: true })?.waiting ?? 0)
    );
  }

  get size(): number {
    let size = 0;
    for (const pool of this.read.values()) {
      size += pool?.size ?? 0;
    }

    for (const pool of this.write.values()) {
      size += pool.size;
    }

    return size;
  }

  get available(): number {
    let available = 0;
    for (const pool of this.read.values()) {
      available += pool?.available ?? 0;
    }

    for (const pool of this.write.values()) {
      available += pool.available;
    }

    return available;
  }

  get using(): number {
    let using = 0;
    for (const pool of this.read.values()) {
      using += pool?.using ?? 0;
    }

    for (const pool of this.write.values()) {
      using += pool.using;
    }

    return using;
  }

  get waiting(): number {
    let waiting = 0;
    for (const pool of this.read.values()) {
      waiting += pool?.waiting ?? 0;
    }

    for (const pool of this.write.values()) {
      waiting += pool.waiting;
    }

    return waiting;
  }
}
