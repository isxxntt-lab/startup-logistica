export const keys = {
  order: (id: string) => `order:${id}`,
  courier: (id: string) => `courier:${id}`,
  route: (id: string) => `route:${id}`,
  courierRoutes: (id: string) => `idx:courier:${id}:routes`,
  orderRoute: (id: string) => `idx:order:${id}:route`,
  geofenceEntered: (routeId: string) => `geofence:entered:${routeId}`,
} as const;

export const streams = {
  orders: "stream:orders",
  locations: "stream:locations",
  geofence: "stream:geofence",
} as const;

export const consumerGroups = {
  routingLocations: "cg:routing-locations",
} as const;
