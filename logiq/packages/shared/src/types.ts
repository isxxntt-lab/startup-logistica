export const ORDER_STATUSES = [
  "pending",
  "assigned",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["assigned", "cancelled", "failed"],
  assigned: ["in_transit", "cancelled", "failed"],
  in_transit: ["delivered", "failed", "cancelled"],
  delivered: [],
  failed: [],
  cancelled: [],
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Order {
  id: string;
  customerName: string;
  addressText: string;
  lat: number;
  lng: number;
  phone?: string;
  status: OrderStatus;
  courierId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CourierLocation {
  lat: number;
  lng: number;
  accuracyM?: number;
  orderId?: string;
  at: string;
}

export interface Courier {
  id: string;
  name: string;
  vehicle?: string;
  lastLocation?: CourierLocation;
  createdAt: string;
  updatedAt: string;
}

export type RouteStatus = "assigned" | "geofence_entered";

export interface RouteAssignment {
  id: string;
  orderId: string;
  courierId: string;
  status: RouteStatus;
  destination: {
    lat: number;
    lng: number;
    addressText: string;
  };
  assignedAt: string;
  updatedAt: string;
  geofenceEntered: boolean;
  geofenceEnteredAt?: string;
  lastDistanceM?: number;
}

export type OrderStreamEvent = {
  type: "order_created" | "order_updated" | "order_status_changed";
  order: Order;
  at: string;
};

export type LocationStreamEvent = {
  type: "location_ping";
  courierId: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  orderId?: string;
  at: string;
};

export type GeofenceStreamEvent = {
  type: "geofence_entered";
  routeId: string;
  orderId: string;
  courierId: string;
  lat: number;
  lng: number;
  distanceM: number;
  radiusM: number;
  at: string;
};
