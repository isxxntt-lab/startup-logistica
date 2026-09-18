const isProd = (process.env.NODE_ENV ?? "development") === "production";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function corsOrigin(): boolean | string[] {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === "*") return true;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required(
    "DATABASE_URL",
    isProd
      ? undefined
      : "postgres://logistica:logistica@localhost:5432/startup_logistica",
  ),
  redisUrl: required(
    "REDIS_URL",
    isProd ? undefined : "redis://localhost:6379",
  ),
  jwtMasterSecret: required(
    "JWT_MASTER_SECRET",
    isProd ? undefined : "dev-only-change-me",
  ),
  publicWebUrl: isProd
    ? required("PUBLIC_WEB_URL")
    : (process.env.PUBLIC_WEB_URL ?? "http://localhost:5173"),
  corsOrigin: corsOrigin(),
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? "dev-verify",
};
