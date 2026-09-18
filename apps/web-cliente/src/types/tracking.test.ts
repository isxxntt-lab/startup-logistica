import { describe, expect, it } from "vitest";
import {
  canConfirmPresence,
  canReschedule,
  recipientSessionStatus,
} from "@startup-logistica/shared/tracking";

describe("recipientSessionStatus", () => {
  it("alinea estados de parada con la UI de destinatario", () => {
    expect(recipientSessionStatus("pendiente")).toBe("pending");
    expect(recipientSessionStatus("notificado")).toBe("pending");
    expect(recipientSessionStatus("confirmado")).toBe("will_be_there");
    expect(recipientSessionStatus("reprogramado")).toBe("rescheduled");
    expect(recipientSessionStatus("entregado")).toBe("used");
    expect(recipientSessionStatus("reasignado")).toBe("used");
  });
});

describe("acciones de destinatario", () => {
  it("Estaré ahí no comparte endpoint con Reprogramar", () => {
    expect(canConfirmPresence("pendiente")).toBe(true);
    expect(canReschedule("pendiente")).toBe(true);
    expect(canConfirmPresence("reprogramado")).toBe(false);
    expect(canReschedule("confirmado")).toBe(true);
  });
});
