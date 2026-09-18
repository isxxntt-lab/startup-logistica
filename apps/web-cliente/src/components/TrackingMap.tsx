import { useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import type { TrackingPosition } from "../types/tracking";
import "leaflet/dist/leaflet.css";

type LatLng = { lat: number; lng: number };

type Props = {
  delivery: LatLng;
  courier: TrackingPosition | null;
};

const deliveryIcon = L.divIcon({
  className: "marker-wrap",
  html: '<div class="pin pin-delivery" title="Entrega"></div>',
  iconSize: [28, 36],
  iconAnchor: [14, 34],
});

const courierIcon = L.divIcon({
  className: "marker-wrap",
  html: '<div class="pin pin-courier" title="Repartidor"></div>',
  iconSize: [28, 36],
  iconAnchor: [14, 34],
});

function InitialFit({ delivery, courier }: Props) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current) return;
    if (courier) {
      const bounds = L.latLngBounds(
        [delivery.lat, delivery.lng],
        [courier.lat, courier.lng],
      );
      map.fitBounds(bounds.pad(0.28), { animate: false });
      fitted.current = true;
      return;
    }
    map.setView([delivery.lat, delivery.lng], 15, { animate: false });
  }, [courier, delivery, map]);

  return null;
}

export default function TrackingMap({ delivery, courier }: Props) {
  const center = useMemo<[number, number]>(
    () => [delivery.lat, delivery.lng],
    [delivery.lat, delivery.lng],
  );

  return (
    <div id="mapa" data-testid="tracking-map">
      <MapContainer
        center={center}
        zoom={15}
        scrollWheelZoom
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <InitialFit delivery={delivery} courier={courier} />
        <Marker position={[delivery.lat, delivery.lng]} icon={deliveryIcon}>
          <Popup>Punto de entrega</Popup>
        </Marker>
        {courier ? (
          <Marker position={[courier.lat, courier.lng]} icon={courierIcon}>
            <Popup>Repartidor en ruta</Popup>
          </Marker>
        ) : null}
      </MapContainer>
    </div>
  );
}
