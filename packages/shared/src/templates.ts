export type PlantillaId =
  | "aviso_cercania"
  | "siguiente_parada"
  | "entrega_confirmada";

export const PLANTILLAS: Record<PlantillaId, string> = {
  aviso_cercania:
    "Hola {{nombre_contacto}}, La furgoneta de {{nombre_empresa}} con el envío {{referencia_pedido}} está a unos 10 minutos de {{direccion_entrega}}. Conductor: {{nombre_conductor}} Vehículo: {{matricula}} Seguimiento: {{enlace_tracking}} — {{nombre_saas}}",
  siguiente_parada:
    "{{nombre_contacto}}, próximo en ruta: Parada {{numero_parada}}/{{total_paradas}} Pedido: {{referencia_pedido}} Dirección: {{direccion_entrega}} ETA: {{eta}} (aprox. {{minutos_restantes}} min). Si necesitáis cambiar algo, responded a este mensaje o llamad a {{telefono_soporte}}. — {{nombre_saas}} · {{nombre_empresa}}",
  entrega_confirmada:
    "Entrega confirmada ✅ Pedido {{referencia_pedido}} entregado con éxito en {{direccion_entrega}} a las {{hora_entrega}}. Receptor: {{nombre_receptor}} Firma / evidencia: {{enlace_pod}} Cualquier incidencia: {{telefono_soporte}} o {{email_soporte}}. Gracias, {{nombre_saas}} · {{nombre_empresa}}",
};

export type VariablesPlantilla = Record<string, string | number | undefined>;

export function renderPlantilla(
  id: PlantillaId,
  vars: VariablesPlantilla,
): string {
  return PLANTILLAS[id].replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function plantillaParaMotivo(
  motivo: "proximidad_geocerca" | "faltan_n_paradas" | "manual" | "entrega_confirmada",
): PlantillaId {
  if (motivo === "faltan_n_paradas") return "siguiente_parada";
  if (motivo === "entrega_confirmada") return "entrega_confirmada";
  return "aviso_cercania";
}
