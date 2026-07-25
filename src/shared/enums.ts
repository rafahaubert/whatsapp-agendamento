/**
 * "Enums" da aplicação.
 *
 * Como usamos SQLite (que não suporta enum no Prisma) e queremos portabilidade
 * total com PostgreSQL, os campos de status são `String` no banco. A segurança
 * de tipos vive aqui: use estes objetos/uniões em todo o código, nunca strings
 * cruas. Se um dia migrarmos para enums nativos do Postgres, os valores batem 1:1.
 */

export const SlotStatus = {
  AVAILABLE: "AVAILABLE",
  BOOKED: "BOOKED",
  BLOCKED: "BLOCKED",
} as const;
export type SlotStatus = (typeof SlotStatus)[keyof typeof SlotStatus];

export const AppointmentStatus = {
  SCHEDULED: "SCHEDULED",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
  RESCHEDULED: "RESCHEDULED",
  COMPLETED: "COMPLETED",
  NO_SHOW: "NO_SHOW",
} as const;
export type AppointmentStatus =
  (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export const PaymentType = {
  PARTICULAR: "PARTICULAR",
  HEALTH_PLAN: "HEALTH_PLAN",
} as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];
