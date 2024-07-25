import type { Pool, TimeoutError } from 'sequelize-pool';
import type { Class } from 'type-fest';

export type BasePoolReleaseOptions = {};
export type BasePoolDestroyOptions = {};
export type BasePoolGetPoolOptions = {};

export type ConnectionType = 'read' | 'write';

export interface ReplicationPoolOptions {
  /**
   * Maximum number of connections in pool. Default is 5
   */
  max: number;

  /**
   * Minimum number of connections in pool. Default is 0
   */
  min: number;

  /**
   * The maximum time, in milliseconds, that a connection can be idle before being released
   */
  idle: number;

  /**
   * The maximum time, in milliseconds, that pool will try to get connection before throwing error
   */
  acquire: number;

  /**
   * The time interval, in milliseconds, after which sequelize-pool will remove idle connections.
   */
  evict: number;

  /**
   * The number of times to use a connection before closing and replacing it.  Default is Infinity
   */
  maxUses: number;
}

export interface BaseReplicationPoolConfig<
  Connection extends object,
  ConnectionOptions extends object,
> {
  readConfig: readonly ConnectionOptions[] | null;
  writeConfig: ConnectionOptions;
  pool: ReplicationPoolOptions;

  // TODO: move this option to sequelize-pool so it applies to sub-pools as well
  timeoutErrorClass?: Class<Error>;

  connect(options: ConnectionOptions): Promise<Connection>;

  disconnect(connection: Connection): Promise<void>;

  validate(connection: Connection): boolean;

  beforeAcquire?(options: AcquireConnectionOptions): Promise<void>;
  afterAcquire?(connection: Connection, options: AcquireConnectionOptions): Promise<void>;
}

export interface AcquireConnectionOptions {
  /**
   * Set which replica to use. Available options are `read` and `write`
   */
  type?: 'read' | 'write';

  /**
   * Force master or write replica to get connection from
   */
  useMaster?: boolean;
}

export interface BaseReplicationPool<Connection extends object> {
  readonly read:
    | Pool<Connection>
    | Array<Pool<Connection>>
    | Map<string, Pool<Connection> | null>
    | null;
  readonly write: Pool<Connection> | Array<Pool<Connection>> | Map<string, Pool<Connection>>;

  readonly timeoutErrorClass: Class<TimeoutError> | undefined;
  readonly beforeAcquire: ((options: AcquireConnectionOptions) => Promise<void>) | undefined;
  readonly afterAcquire:
    | ((connection: Connection, options: AcquireConnectionOptions) => Promise<void>)
    | undefined;

  acquire(options: AcquireConnectionOptions): Promise<Connection>;

  release(options: BasePoolReleaseOptions): void;
  destroy(options: BasePoolDestroyOptions): Promise<void>;
  destroyAllNow(): Promise<void>;
  drain(): Promise<void>;
  getPool(options: BasePoolGetPoolOptions): Pool<Connection> | null;

  get size(): number;
  get available(): number;
  get using(): number;
  get waiting(): number;
}
