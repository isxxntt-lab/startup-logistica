function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://logistica:logistica@localhost:5432/startup_logistica",
  ),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  jwtMasterSecret: required("JWT_MASTER_SECRET", "dev-only-change-me"),
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? "http://localhost:5173",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? "dev-verify",
};
