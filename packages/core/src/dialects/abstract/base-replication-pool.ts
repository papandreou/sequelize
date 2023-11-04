import type { Pool } from 'sequelize-pool';
import type { ConnectionOptions, NormalizedPoolOptions } from '../../sequelize.js';

export type BasePoolAcquireOptions = {};
export type BasePoolReleaseOptions = {};
export type BasePoolDestroyOptions = {};
export type BasePoolGetPoolOptions = {};

export type BaseReplicationPoolConfig<Resource> = {

    pool: Omit<NormalizedPoolOptions, 'validate'>,

    connect(options: ConnectionOptions): Promise<Resource>,
    disconnect(connection: Resource): Promise<void>,
    validate(connection: Resource): boolean,
};

export interface BaseReplicationPool<Resource extends object> {

  readonly read: Pool<Resource> | Array<Pool<Resource>> | Map<string, Pool<Resource> | null> | null;
  readonly write: Pool<Resource> | Array<Pool<Resource>> | Map<string, Pool<Resource>> | null;

  acquire(options: object): Promise<Resource>;

  release(options: BasePoolReleaseOptions): void;
  destroy(options: BasePoolAcquireOptions): Promise<void>;
  destroyAllNow(): Promise<void>;
  drain(): Promise<void>;
  getPool(options: BasePoolGetPoolOptions): Pool<Resource> | null;

  readonly size: number;
  readonly available: number;
  readonly using: number;
  readonly waiting: number;
}

export type ConnectionType = 'read' | 'write';
