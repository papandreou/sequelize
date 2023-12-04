import { Pool } from 'sequelize-pool';
import type { ConnectionOptions, NormalizedPoolOptions } from '../../sequelize.js';
import { logger } from '../../utils/logger.js';
import type { BaseReplicationPool, ConnectionType } from './base-replication-pool.js';
import type {
  ReplicationPoolAcquireOptions,
  ReplicationPoolDestroyOptions,
  ReplicationPoolGetPoolOptions,
  ReplicationPoolReleaseOptions,
} from './replication-pool.js';

type ShardValue = `read:${string}` | `write:${string}`;

export type ShardConfig = {
  shardId: string,
  readConfig: ConnectionOptions[] | null,
  writeConfig: ConnectionOptions,

};

export type ShardedReplicationPoolConfig<Resource> = {

    shards: ShardConfig[],

    pool: Omit<NormalizedPoolOptions, 'validate'>,

    connect(options: ConnectionOptions): Promise<Resource>,
    disconnect(connection: Resource): Promise<void>,
    validate(connection: Resource): boolean,

};

type ShardIdentifier = { shardId: string };

type ShardedReplicationPoolAcquireOptions =
ReplicationPoolAcquireOptions & ShardIdentifier;

type ShardedReplicationPoolReleaseOptions<Resource> =
ReplicationPoolReleaseOptions<Resource>;

type ShardedReplicationPoolDestroyOptions<Resource> =
ReplicationPoolDestroyOptions<Resource>;

type ShardedReplicationPoolGetPoolOptions =
ReplicationPoolGetPoolOptions & ShardIdentifier;

const debug = logger.debugContext('pool');

const owningPools = new WeakMap<object, ShardValue>();

function shardValueToTuple(shardValue: ShardValue): [string, ConnectionType] {
  const [type, shardId] = shardValue.split(':');

  return [shardId, type as ConnectionType];
}

interface ShardedObject extends Object {
  shardId?: string | undefined;
}

export class ShardedReplicationPool<Resource extends ShardedObject> implements BaseReplicationPool<Resource> {

  readonly read: Map<string, Pool<Resource> | null> = new Map();
  readonly write: Map<string, Pool<Resource>> = new Map();

  constructor(config: ShardedReplicationPoolConfig<Resource>) {

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

  async acquire({ shardId, type = 'write', useMaster = false }: ShardedReplicationPoolAcquireOptions): Promise<Resource> {

    if (type !== 'read' && type !== 'write') {
      throw new Error(`Expected queryType to be either read or write. Received ${type}`);
    }

    const pool = this.getPool({ shardId, poolType: type });

    if (pool == null) {
      throw new Error(`No ${type} pool found for shard ${shardId}`);
    }

    if (type === 'read' && !useMaster) {

      const connection = await pool.acquire();

      connection.shardId = shardId;

      return connection;

    }

    const connection = await pool.acquire();
    connection.shardId = shardId;

    return connection;

  }

  release({ connection }: ShardedReplicationPoolReleaseOptions<Resource>): void {
    const shardValue = owningPools.get(connection);
    if (!shardValue) {
      throw new Error('Unable to determine to which sharded pool the connection belongs');
    }

    const [shardId, type] = shardValueToTuple(shardValue);

    this.getPool({ shardId, poolType: type })?.release(connection);

  }

  async destroy({ connection }: ShardedReplicationPoolDestroyOptions<Resource>): Promise<void> {
    const shardValue = owningPools.get(connection);
    if (!shardValue) {
      throw new Error('Unable to determine to which sharded pool the connection belongs');
    }

    const [shardId, type] = shardValueToTuple(shardValue);

    await this.getPool({ shardId, poolType: type })?.destroy(connection);
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

  getPool({ shardId, poolType }: ShardedReplicationPoolGetPoolOptions): Pool<Resource> | null {

    if (poolType === 'read' && this.read != null) {
      return this.read.get(shardId) ?? null;
    }

    return this.write.get(shardId) ?? null;
  }

  shardSize(shardId: string): number {

    return this.getPool({ shardId, poolType: 'read' })?.size ?? 0 + (this.getPool({ shardId, poolType: 'write' })?.size ?? 0);

  }

  shardAvailable(shardId: string): number {
    return this.getPool({ shardId, poolType: 'read' })?.available ?? 0 + (this.getPool({ shardId, poolType: 'write' })?.available ?? 0);
  }

  shardUsing(shardId: string): number {
    return this.getPool({ shardId, poolType: 'read' })?.using ?? 0 + (this.getPool({ shardId, poolType: 'write' })?.using ?? 0);
  }

  shardWaiting(shardId: string): number {
    return this.getPool({ shardId, poolType: 'read' })?.waiting ?? 0 + (this.getPool({ shardId, poolType: 'write' })?.waiting ?? 0);
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
