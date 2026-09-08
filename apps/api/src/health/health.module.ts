import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres.health';
import { StorageHealthIndicator } from './storage.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator, StorageHealthIndicator],
})
export class HealthModule {}
