import { buildApp } from "./app.ts";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const app = buildApp();

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, "mailuo server listening");
} catch (error) {
  app.log.error({ err: error }, "mailuo server failed to start");
  process.exit(1);
}
