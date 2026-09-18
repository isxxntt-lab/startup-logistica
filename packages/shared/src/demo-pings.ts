export const GROK_LOCATION_PINGS = [
  {
    event: "location_update" as const,
    courier_id: "repartidor_001",
    order_id: "ORD-TEST-001",
    timestamp: "2026-09-18T14:40:00+02:00",
    location: {
      lat: 40.427555,
      lng: -3.70379,
      accuracy_m: 12.5,
      altitude_m: 655.0,
      heading_deg: 180.0,
      speed_mps: 8.3,
    },
  },
  {
    event: "location_update" as const,
    courier_id: "repartidor_001",
    order_id: "ORD-TEST-001",
    timestamp: "2026-09-18T14:42:30+02:00",
    location: {
      lat: 40.421267,
      lng: -3.70379,
      accuracy_m: 8.0,
      altitude_m: 650.0,
      heading_deg: 180.0,
      speed_mps: 6.1,
    },
  },
  {
    event: "location_update" as const,
    courier_id: "repartidor_001",
    order_id: "ORD-TEST-001",
    timestamp: "2026-09-18T14:45:00+02:00",
    location: {
      lat: 40.416775,
      lng: -3.70379,
      accuracy_m: 4.2,
      altitude_m: 648.0,
      heading_deg: 0.0,
      speed_mps: 0.0,
    },
  },
];
