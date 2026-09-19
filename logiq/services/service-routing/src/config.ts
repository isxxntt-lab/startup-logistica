import { requireInternalServiceToken } from "@logiq/shared";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3002),
  redisUrl: required("REDIS_URL"),
  serviceName: "routing",
  geofenceRadiusM: Number(process.env.GEOFENCE_RADIUS_M ?? 500),
  consumerName: process.env.ROUTING_CONSUMER_NAME ?? "routing-1",
  internalServiceToken: requireInternalServiceToken(),
};
