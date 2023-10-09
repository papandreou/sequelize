
import { Pool } from 'sequelize-pool';
import type { ConnectionOptions, NormalizedPoolOptions } from '../../sequelize.js';
import { logger } from '../../utils/logger.js';
import type {
  BasePoolAcquireOptions,
  BasePoolDestroyOptions,
  BasePoolGetPoolOptions,
  BasePoolReleaseOptions,
  BaseReplicationPool,
  ConnectionType,
} from './base-replication-pool.js';

const debug = logger.debugContext('pool');

export type ReplicationPoolConfig<Resource> = {
  readConfig: ConnectionOptions[] | null,
  writeConfig: ConnectionOptions,
  pool: Omit<NormalizedPoolOptions, 'validate'>,

  connect(options: ConnectionOptions): Promise<Resource>,
  disconnect(connection: Resource): Promise<void>,
  validate(connection: Resource): boolean,
};

export type ReplicationPoolAcquireOptions = BasePoolAcquireOptions & {
 type: ConnectionType, useMaster: boolean,
};
export type ReplicationPoolReleaseOptions<Resource> = BasePoolReleaseOptions &
{ connection: Resource };

export type ReplicationPoolDestroyOptions<Resource> = BasePoolDestroyOptions &
{ connection: Resource };

export type ReplicationPoolGetPoolOptions = BasePoolGetPoolOptions &
{ poolType: ConnectionType };

const owningPools = new WeakMap<object, 'read' | 'write'>();

export class ReplicationPool<Resource extends object> implements BaseReplicationPool<Resource> {
  /**
   * Replication read pool. Will only be used if the 'read' replication option has been provided,
   * otherwise the {@link write} will be used instead.
   */
  readonly read: Pool<Resource> | null;
  readonly write: Pool<Resource>;

  constructor(config: ReplicationPoolConfig<Resource>) {

    const { connect, disconnect, validate, readConfig, writeConfig } = config;

    if (!readConfig || readConfig.length === 0) {
      // no replication, the write pool will always be used instead
      this.read = null;
    } else {
      let reads = 0;

      this.read = new Pool({
        name: 'sequelize:read',
        create: async () => {
          // round robin config
          const nextRead = reads++ % readConfig.length;
          const connection = await connect(readConfig[nextRead]);

          owningPools.set(connection, 'read');

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
    }

    this.write = new Pool({
      name: 'sequelize:write',
      create: async () => {
        const connection = await connect(writeConfig);

        owningPools.set(connection, 'write');

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
  }

  async acquire({ type = 'write', useMaster = false }: ReplicationPoolAcquireOptions): Promise<Resource> {
    if (type !== 'read' && type !== 'write') {
      throw new Error(`Expected queryType to be either read or write. Received ${type}`);
    }

    if (this.read != null && type === 'read' && !useMaster) {
      return this.read.acquire();
    }

    return this.write.acquire();
  }

  release({ connection }: ReplicationPoolReleaseOptions<Resource>): void {

    const connectionType = owningPools.get(connection);
    if (!connectionType) {
      throw new Error('Unable to determine to which pool the connection belongs');
    }

    this.getPool({ poolType: connectionType }).release(connection);
  }

  async destroy({ connection }: ReplicationPoolDestroyOptions<Resource>): Promise<void> {
    const connectionType = owningPools.get(connection);
    if (!connectionType) {
      throw new Error('Unable to determine to which pool the connection belongs');
    }

    await this.getPool({ poolType: connectionType }).destroy(connection);
    debug('connection destroy');
  }

  async destroyAllNow() {
    await Promise.all([
      this.read?.destroyAllNow(),
      this.write.destroyAllNow(),
    ]);

    debug('all connections destroyed');
  }

  async drain() {
    await Promise.all([
      this.write.drain(),
      this.read?.drain(),
    ]);
  }

  getPool({ poolType }: ReplicationPoolGetPoolOptions): Pool<Resource> {
    if (poolType === 'read' && this.read != null) {
      return this.read;
    }

    return this.write;
  }

  get size(): number {
    return (this.read?.size ?? 0) + this.write.size;
  }

  get available(): number {
    return (this.read?.available ?? 0) + this.write.available;
  }

  get using(): number {
    return (this.read?.using ?? 0) + this.write.using;
  }

  get waiting(): number {
    return (this.read?.waiting ?? 0) + this.write.waiting;
  }
}
