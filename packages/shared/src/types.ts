export type PlanAgencia = "free" | "pro" | "enterprise";

export type EstadoRuta = "planificada" | "en_curso" | "finalizada";

export type EstadoParada =
  | "pendiente"
  | "notificado"
  | "confirmado"
  | "entregado"
  | "ausente"
  | "reprogramado"
  | "reasignado";

export type TipoNotificacion = "whatsapp" | "sms" | "push_repartidor";
export type ProveedorMensajeria = "twilio" | "meta" | "fcm";
export type EstadoEnvio =
  | "pendiente"
  | "enviado"
  | "entregado"
  | "leido"
  | "fallido";

export type MotivoNotificacion =
  | "proximidad_geocerca"
  | "faltan_n_paradas"
  | "manual"
  | "entrega_confirmada";

export interface ClienteJwtClaims {
  parada_id: string;
  agencia_id: string;
  exp: number;
}

export interface AccionCliente {
  accion: "confirmado" | "ausente" | "reprogramado" | "reasignado";
  notas?: string;
  punto_recogida_id?: string;
  ventana_alternativa?: string;
}
