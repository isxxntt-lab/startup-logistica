import { requireInternalServiceToken } from "@logiq/shared";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  redisUrl: required("REDIS_URL"),
  serviceName: "fleet",
  internalServiceToken: requireInternalServiceToken(),
};
