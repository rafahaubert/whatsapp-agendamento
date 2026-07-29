/**
 * Diagnóstico da agenda — responde "por que o bot diz que não tem horário à tarde?".
 *
 * O agente nunca inventa a resposta: quando `listar_horarios` volta vazia, ele
 * repete o aviso da ferramenta ("Nenhum horário livre no período tarde"). Ou
 * seja, a pergunta real é sempre a mesma: a agenda GERADA tem aquele período?
 *
 * O painel mostra consultas marcadas, nunca os horários LIVRES — então esse
 * confronto (o que a config promete × o que existe no banco) não dá para fazer
 * pela tela. Este script faz.
 *
 * Uso:
 *   npm run diagnostico                 # todas as clínicas
 *   npm run diagnostico -- clinica-teste
 */
import { DateTime } from "luxon";
import { prisma } from "../src/db/client.js";
import { SlotStatus } from "../src/shared/enums.js";
import { janelaAtendimento, resumoAgenda, ORDEM_PERIODOS, PERIODOS } from "../src/domain/horarios.js";
import type { TenantConfig, DiaAtendimento } from "../src/config/types.js";
import type { Periodo } from "../src/domain/horarios.js";

/** Teto de horários lidos por clínica — só para não puxar a agenda inteira à toa. */
const MAX_SLOTS = 20_000;
/** Quantos dias detalhar na tabela dia a dia. */
const DIAS_DETALHE = 14;

const alvo = process.argv[2]?.trim();

function periodoDe(quando: Date, timezone: string): Periodo {
  const hora = DateTime.fromJSDate(quando).setZone(timezone).hour;
  for (const p of ORDEM_PERIODOS) {
    const [ini, fim] = PERIODOS[p];
    if (hora >= ini && hora < fim) return p;
  }
  return "noite";
}

/** A agenda que o GERADOR usa para este profissional (própria ou herdada). */
function agendaDoProfissional(
  workingHours: string | null,
  clinica: Record<number, DiaAtendimento | null>,
): { days: Record<number, DiaAtendimento | null>; propria: boolean; invalida: boolean } {
  if (!workingHours) return { days: clinica, propria: false, invalida: false };
  try {
    return { days: JSON.parse(workingHours), propria: true, invalida: false };
  } catch {
    // Mesmo silêncio do gerador: JSON quebrado cai no horário da clínica.
    return { days: clinica, propria: false, invalida: true };
  }
}

// A mesma leitura, sem terminal, está em Agendamentos → "Ver horários livres"
// (src/admin/tenantAdmin.ts → diagnosticarAgenda). Este script continua útil
// para rodar contra o banco de produção a partir da máquina de quem mantém.

async function diagnosticar(tenant: {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  config: string;
}) {
  const tz = tenant.timezone;
  let cfg: TenantConfig;
  try {
    cfg = JSON.parse(tenant.config) as TenantConfig;
  } catch {
    console.log(`\n### ${tenant.name} (${tenant.slug}) — config ilegível, pulando.`);
    return;
  }

  const duracao = cfg.booking.slotDurationMinutes;
  const janelaDias = cfg.booking.advanceBookingDays || 30;
  const janela = janelaAtendimento(cfg.businessHours.days, duracao);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`### ${tenant.name} (${tenant.slug}) — fuso ${tz}`);
  console.log(`${"=".repeat(72)}`);

  // ---------- 1. O que o system prompt PROMETE ao paciente ----------
  console.log("\n[1] O que o assistente anuncia (vem de businessHours da clínica)");
  console.log(`  Funcionamento......: ${janela.resumo}`);
  console.log(`  Último de cada dia.: ${janela.ultimoPorDia}`);
  console.log(`  Períodos anunciados: ${janela.periodos.join(", ") || "(nenhum)"}`);
  console.log(`  Slot de ${duracao} min · janela de ${janelaDias} dias`);

  // ---------- 2. A agenda que o GERADOR realmente usa ----------
  const doctors = await prisma.doctor.findMany({
    where: { tenantId: tenant.id, isActive: true },
    include: { specialties: { select: { name: true } }, units: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  console.log("\n[2] Agenda de cada profissional (é ela que gera os horários)");
  if (doctors.length === 0) console.log("  (nenhum profissional ativo — a agenda sai vazia)");

  const periodosGeraveis = new Set<Periodo>();
  for (const d of doctors) {
    const { days, propria, invalida } = agendaDoProfissional(d.workingHours, cfg.businessHours.days);
    const j = janelaAtendimento(days, duracao);
    for (const p of j.periodos) periodosGeraveis.add(p);

    const origem = invalida
      ? "agenda própria com JSON INVÁLIDO → caiu no horário da clínica"
      : propria
        ? "agenda PRÓPRIA"
        : "herda a clínica";
    console.log(`  • ${d.name} — ${origem}`);
    console.log(`      ${resumoAgenda(days)}`);
    console.log(`      períodos: ${j.periodos.join(", ") || "(nenhum)"}`);
    if (d.specialties.length === 0) console.log("      ⚠ sem especialidade — não gera horário nenhum");
    if (d.units.length === 0) console.log("      ⚠ sem unidade — não gera horário nenhum");
  }

  // ---------- 3. O que existe DE FATO no banco ----------
  const agora = new Date();
  const limite = new Date(agora.getTime() + janelaDias * 86_400_000);
  const slots = await prisma.slot.findMany({
    where: {
      tenantId: tenant.id,
      status: SlotStatus.AVAILABLE,
      startsAt: { gte: agora, lte: limite },
    },
    select: { startsAt: true, specialty: { select: { name: true } }, doctor: { select: { name: true } } },
    orderBy: { startsAt: "asc" },
    take: MAX_SLOTS,
  });

  const porPeriodo = new Map<Periodo, number>();
  const porDia = new Map<string, Map<Periodo, number>>();
  const porEspecialidade = new Map<string, Map<Periodo, number>>();

  for (const s of slots) {
    const p = periodoDe(s.startsAt, tz);
    const dia = DateTime.fromJSDate(s.startsAt).setZone(tz).toFormat("ccc dd/LL");
    porPeriodo.set(p, (porPeriodo.get(p) ?? 0) + 1);
    if (!porDia.has(dia)) porDia.set(dia, new Map());
    porDia.get(dia)!.set(p, (porDia.get(dia)!.get(p) ?? 0) + 1);
    const esp = s.specialty.name;
    if (!porEspecialidade.has(esp)) porEspecialidade.set(esp, new Map());
    porEspecialidade.get(esp)!.set(p, (porEspecialidade.get(esp)!.get(p) ?? 0) + 1);
  }

  const linha = (m: Map<Periodo, number>) =>
    ORDEM_PERIODOS.map((p) => `${p}: ${String(m.get(p) ?? 0).padStart(4)}`).join(" · ");

  console.log(`\n[3] Horários LIVRES no banco (próximos ${janelaDias} dias) — total ${slots.length}`);
  if (slots.length >= MAX_SLOTS) console.log(`  (leitura limitada a ${MAX_SLOTS}; os números abaixo são um piso)`);
  console.log(`  Geral: ${linha(porPeriodo)}`);

  console.log(`\n  Por especialidade (é assim que o bot busca):`);
  for (const [esp, m] of [...porEspecialidade].sort()) {
    const semTarde = (m.get("tarde") ?? 0) === 0 ? "   ← SEM TARDE" : "";
    console.log(`    ${esp.padEnd(24)} ${linha(m)}${semTarde}`);
  }

  console.log(`\n  Dia a dia (primeiros ${DIAS_DETALHE} dias com horário):`);
  for (const [dia, m] of [...porDia].slice(0, DIAS_DETALHE)) {
    console.log(`    ${dia}  ${linha(m)}`);
  }

  // ---------- 4. Bloqueios (férias, feriados, ausências) ----------
  const bloqueios = await prisma.block.findMany({
    where: { tenantId: tenant.id, endsAt: { gte: agora } },
    include: { doctor: { select: { name: true } } },
    orderBy: { startsAt: "asc" },
  });
  console.log(`\n[4] Bloqueios ativos: ${bloqueios.length}`);
  for (const b of bloqueios.slice(0, 20)) {
    const de = DateTime.fromJSDate(b.startsAt).setZone(tz).toFormat("dd/LL HH:mm");
    const ate = DateTime.fromJSDate(b.endsAt).setZone(tz).toFormat("dd/LL HH:mm");
    console.log(`  • ${b.doctor?.name ?? "clínica inteira"}: ${de} → ${ate} ${b.reason ? `(${b.reason})` : ""}`);
  }

  // ---------- 5. Veredito ----------
  console.log("\n[5] Diagnóstico");
  const anunciaTarde = janela.periodos.includes("tarde");
  const geravelTarde = periodosGeraveis.has("tarde");
  const existeTarde = (porPeriodo.get("tarde") ?? 0) > 0;

  if (existeTarde) {
    const semTarde = [...porEspecialidade].filter(([, m]) => (m.get("tarde") ?? 0) === 0);
    if (semTarde.length) {
      console.log(`  ⚠ Há tarde na agenda, mas NÃO em: ${semTarde.map(([e]) => e).join(", ")}.`);
      console.log("    O bot busca POR ESPECIALIDADE — nessas ele responde que não tem tarde.");
      console.log("    Causa: o profissional dessa especialidade não atende à tarde.");
    } else {
      console.log("  ✓ Existe horário livre à tarde em todas as especialidades.");
      console.log("    Se o bot ainda nega a tarde, veja a conversa no painel: provavelmente ele");
      console.log("    filtrou também por DIA ou por profissional que de fato não tem tarde.");
    }
  } else if (!geravelTarde) {
    console.log("  ✗ Nenhum profissional atende à tarde — por isso a agenda não tem tarde.");
    if (anunciaTarde) {
      console.log("    ATENÇÃO: a clínica ANUNCIA tarde (businessHours vai até depois das 12h),");
      console.log("    mas os horários saem da agenda de cada profissional. O assistente promete");
      console.log("    um período que a agenda nunca teve.");
      console.log("    Corrija em Configurações → Equipe → agenda do profissional,");
      console.log("    ou marque 'herdar o horário da clínica'. Depois GERE OS HORÁRIOS.");
    } else {
      console.log("    A config da clínica também fecha antes das 12h — está coerente.");
      console.log("    Para ter tarde: Configurações → Dados da clínica → horário, e gere os horários.");
    }
  } else {
    console.log("  ✗ A agenda dos profissionais PREVÊ tarde, mas não há nenhum horário livre");
    console.log("    de tarde no banco. Causas prováveis, nesta ordem:");
    console.log("    1. os horários não foram gerados depois da última mudança de horário");
    console.log("       (salvar a configuração NÃO regenera a agenda — use 'Gerar horários');");
    console.log("    2. um bloqueio cobrindo as tardes (ver [4]);");
    console.log("    3. as tardes estão todas reservadas.");
  }
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: alvo ? { slug: alvo } : {},
    orderBy: { name: "asc" },
  });

  if (tenants.length === 0) {
    console.error(alvo ? `Nenhuma clínica com slug "${alvo}".` : "Nenhuma clínica cadastrada.");
    process.exit(1);
  }

  for (const t of tenants) await diagnosticar(t);
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
