/**
 * DI token for the connection pool. A symbol rather than a string so nothing
 * else can collide with it by accident.
 *
 * Its own file because database.module.ts imports TenantDb and TenantDb imports
 * this — sharing a file would be a cycle
 */
export const PG_POOL = Symbol('PG_POOL');
