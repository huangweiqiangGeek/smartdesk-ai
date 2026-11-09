import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'database/schema/schema.prisma',
  migrations: { path: 'database/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://smartdesk:smartdesk_local@127.0.0.1:55432/smartdesk',
  },
});
