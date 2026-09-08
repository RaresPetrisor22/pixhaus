/**
 * What other packages may import from @pixhaus/db.
 *
 * Only the tenant wall. The migration runner is not here on purpose — it runs
 * as the OWNER role, and nothing at runtime should be able to reach it.
 */
export { withTenant, type TenantClient } from './tenant.js';
