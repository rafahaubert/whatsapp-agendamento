import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import type { PrismaClient } from "@prisma/client";
import type { ClinicFile, TenantConfig } from "../config/types.js";
import { SlotStatus } from "../shared/enums.js";
import { minutosDoDia, noIntervalo } from "../domain/horarios.js";

// As regras puras de horário vivem em src/domain/horarios.ts (para o system
// prompt poder usá-las sem arrastar o Prisma). Re-exportadas aqui porque o
// gerador é o principal consumidor.
export { minutosDoDia, noIntervalo };

const CLINICS_DIR = path.resolve(process.cwd(), "config", "clinics");

/** Lê todos os config/clinics/*.json. */
export async function loadClinicFiles(): Promise<ClinicFile[]> {
  const files = await readdir(CLINICS_DIR);
  const jsons = files.filter((f) => f.endsWith(".json"));
  const result: ClinicFile[] = [];
  for (const f of jsons) {
    const raw = await readFile(path.join(CLINICS_DIR, f), "utf-8");
    result.push(JSON.parse(raw) as ClinicFile);
  }
  return result;
}

export interface Bloqueio {
  doctorId: string | null; // null = clínica inteira (feriado)
  startsAt: Date;
  endsAt: Date;
}

/** O horário está dentro de férias/feriado (da clínica ou do profissional)? */
export function estaBloqueado(
  inicio: Date,
  fim: Date,
  doctorId: string,
  bloqueios: Bloqueio[],
): boolean {
  return bloqueios.some(
    (b) =>
      (b.doctorId === null || b.doctorId === doctorId) &&
      inicio < b.endsAt &&
      fim > b.startsAt,
  );
}

type SlotRow = {
  tenantId: string;
  unitId: string;
  doctorId: string;
  specialtyId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
};

/**
 * (Re)gera os horários LIVRES de uma clínica (preserva os já reservados).
 * Gerador simplificado para demonstração: cobre os próximos `slotDays` dias
 * dentro do horário de funcionamento. Reutilizado pelo seed e pelo painel.
 */
export async function regenerateSlots(
  prisma: PrismaClient,
  params: { tenantId: string; timezone: string; config: TenantConfig; slotDays: number },
): Promise<number> {
  const { tenantId, timezone, config, slotDays } = params;

  await prisma.slot.deleteMany({ where: { tenantId, status: SlotStatus.AVAILABLE } });

  const doctors = await prisma.doctor.findMany({
    where: { tenantId, isActive: true },
    include: { units: true, specialties: true },
  });

  const now = DateTime.now().setZone(timezone);

  // Férias/feriados que alcançam a janela sendo gerada.
  const bloqueios = await prisma.block.findMany({
    where: { tenantId, endsAt: { gte: now.toJSDate() } },
    select: { doctorId: true, startsAt: true, endsAt: true },
  });

  const rows: SlotRow[] = [];

  for (const doctor of doctors) {
    // Agenda do dentista (se definida) tem prioridade sobre o horário da clínica.
    let agenda = config.businessHours.days;
    if (doctor.workingHours) {
      try {
        agenda = JSON.parse(doctor.workingHours) as typeof agenda;
      } catch {
        /* JSON inválido → mantém o horário da clínica */
      }
    }

    for (const unit of doctor.units) {
      for (const spec of doctor.specialties) {
        for (let day = 0; day < slotDays; day++) {
          const base = now.plus({ days: day }).startOf("day");
          const cfgDay = base.weekday === 7 ? 0 : base.weekday; // luxon 1=seg..7=dom → 0=dom..6=sáb
          const hours = agenda[cfgDay];
          if (!hours) continue;

          const [oh, om] = hours.open.split(":").map(Number);
          const [ch, cm] = hours.close.split(":").map(Number);
          const close = base.set({ hour: ch, minute: cm });
          let cursor = base.set({ hour: oh, minute: om });

          const duracao = config.booking.slotDurationMinutes;

          while (cursor < close) {
            const fim = cursor.plus({ minutes: duracao });
            const inicioMin = cursor.hour * 60 + cursor.minute;
            const fimMin = inicioMin + duracao;

            const valido =
              cursor > now &&
              !noIntervalo(inicioMin, fimMin, hours) &&
              !estaBloqueado(cursor.toJSDate(), fim.toJSDate(), doctor.id, bloqueios);

            if (valido) {
              rows.push({
                tenantId,
                unitId: unit.id,
                doctorId: doctor.id,
                specialtyId: spec.id,
                startsAt: cursor.toJSDate(),
                endsAt: fim.toJSDate(),
                status: SlotStatus.AVAILABLE,
              });
            }
            cursor = fim;
          }
        }
      }
    }
  }

  if (rows.length) await prisma.slot.createMany({ data: rows });
  return rows.length;
}

/**
 * Popula (idempotente) uma clínica: tenant, unidades, especialidades,
 * convênios/planos, médicos (com vínculos m-n) e horários de exemplo.
 */
export async function seedClinic(
  prisma: PrismaClient,
  file: ClinicFile,
  opts: { slotDays?: number } = {},
) {
  const slotDays = opts.slotDays ?? 7;
  const cfg = file.config;
  const timezone = file.timezone ?? cfg.businessHours.timezone ?? "America/Sao_Paulo";

  // 1) Tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: file.slug },
    update: {
      name: file.name,
      timezone,
      whatsappPhoneNumberId: file.whatsappPhoneNumberId,
      whatsappBusinessId: file.whatsappBusinessId ?? null,
      config: JSON.stringify(cfg),
    },
    create: {
      slug: file.slug,
      name: file.name,
      timezone,
      whatsappPhoneNumberId: file.whatsappPhoneNumberId,
      whatsappBusinessId: file.whatsappBusinessId ?? null,
      config: JSON.stringify(cfg),
    },
  });

  // 2) Unidades
  const unitByName = new Map<string, { id: string }>();
  for (const u of file.catalog.units) {
    const unit = await prisma.unit.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: u.name } },
      update: { address: u.address ?? null, phone: u.phone ?? null, timezone: u.timezone ?? null },
      create: {
        tenantId: tenant.id,
        name: u.name,
        address: u.address ?? null,
        phone: u.phone ?? null,
        timezone: u.timezone ?? null,
      },
    });
    unitByName.set(u.name, unit);
  }

  // 3) Especialidades
  const specByName = new Map<string, { id: string }>();
  for (const name of file.catalog.specialties) {
    const s = await prisma.specialty.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name } },
      update: {},
      create: { tenantId: tenant.id, name },
    });
    specByName.set(name, s);
  }

  // 4) Convênios + planos
  const planByName = new Map<string, { id: string }>();
  for (const ins of file.catalog.insurers) {
    const insurer = await prisma.insurer.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: ins.name } },
      update: { code: ins.code ?? null },
      create: { tenantId: tenant.id, name: ins.name, code: ins.code ?? null },
    });
    for (const planName of ins.plans) {
      const plan = await prisma.healthPlan.upsert({
        where: {
          tenantId_insurerId_name: { tenantId: tenant.id, insurerId: insurer.id, name: planName },
        },
        update: {},
        create: { tenantId: tenant.id, insurerId: insurer.id, name: planName },
      });
      planByName.set(planName, plan);
    }
  }

  // 5) Médicos (vínculos m-n)
  const idsOf = (names: string[], map: Map<string, { id: string }>) =>
    names.map((n) => map.get(n)?.id).filter((id): id is string => Boolean(id)).map((id) => ({ id }));

  let doctorCount = 0;
  for (const d of file.catalog.doctors) {
    const specialties = idsOf(d.specialties, specByName);
    const units = idsOf(d.units, unitByName);
    const healthPlans = idsOf(d.acceptedPlans ?? [], planByName);

    const existing = await prisma.doctor.findFirst({ where: { tenantId: tenant.id, name: d.name } });
    if (existing) {
      await prisma.doctor.update({
        where: { id: existing.id },
        data: {
          crm: d.crm ?? null,
          specialties: { set: specialties },
          units: { set: units },
          healthPlans: { set: healthPlans },
        },
      });
    } else {
      await prisma.doctor.create({
        data: {
          tenantId: tenant.id,
          name: d.name,
          crm: d.crm ?? null,
          specialties: { connect: specialties },
          units: { connect: units },
          healthPlans: { connect: healthPlans },
        },
      });
    }
    doctorCount++;
  }

  // 6) Horários
  const slots = await regenerateSlots(prisma, { tenantId: tenant.id, timezone, config: cfg, slotDays });

  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    units: unitByName.size,
    specialties: specByName.size,
    plans: planByName.size,
    doctors: doctorCount,
    slots,
  };
}
