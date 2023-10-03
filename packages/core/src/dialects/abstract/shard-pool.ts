import type { ReplicationPoolConfig } from './replication-pool';
import { ReplicationPool } from './replication-pool';

type ShardConfig<Resource> = ReplicationPoolConfig<Resource> & { shardId: string };

type ShardPoolConfig<Resource> =
{
    shards: Array<ShardConfig<Resource>>,
    // maybe add other options here later
};

export class ShardPool<Resource extends object> {

  private readonly shards: Map<string, ReplicationPool<Resource> | null> = new Map();

  constructor(config: ShardPoolConfig<Resource>) {

    for (const shardConfig of config.shards) {
      this.shards.set(shardConfig.shardId, new ReplicationPool({
        ...shardConfig,
      }));
    }
  }

  getShardPool(shardId: string): ReplicationPool<Resource> | null {
    return this.shards.get(shardId) ?? null;
  }
}
