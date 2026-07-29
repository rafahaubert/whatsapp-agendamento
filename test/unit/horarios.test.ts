import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { umPorHorario } from "../../src/domain/scheduling.js";
import {
  avisoPeriodoVazio,
  escolherHorarios,
  janelaAtendimento,
  parseHoraPreferida,
  periodosGeraveis,
  resolverDia,
} from "../../src/domain/horarios.js";

const h = (hora: number, doctorId: string, id = `${hora}-${doctorId}`) => ({
  id,
  doctorId,
  startsAt: new Date(`2026-07-27T${String(hora).padStart(2, "0")}:00:00.000Z`),
});

describe("umPorHorario", () => {
  it("oferece horários DIFERENTES quando dois profissionais coincidem", () => {
    const slots = [h(8, "dr1"), h(8, "dr2"), h(9, "dr2"), h(10, "dr1")];
    const r = umPorHorario(slots);
    expect(r).toHaveLength(3);
    expect(r.map((s) => s.startsAt.getUTCHours())).toEqual([8, 9, 10]);
  });

  it("mantém a ordem recebida (ex.: ordenação por hora preferida)", () => {
    const slots = [h(20, "dr1"), h(8, "dr1"), h(14, "dr1")];
    expect(umPorHorario(slots).map((s) => s.startsAt.getUTCHours())).toEqual([20, 8, 14]);
  });

  it("no empate, prioriza o profissional que já atendeu o paciente", () => {
    const slots = [h(8, "dr1"), h(8, "dr2")];
    expect(umPorHorario(slots, "dr2")[0].doctorId).toBe("dr2");
  });

  it("sem profissional habitual, fica com o primeiro do horário", () => {
    const slots = [h(8, "dr1"), h(8, "dr2")];
    expect(umPorHorario(slots)[0].doctorId).toBe("dr1");
  });

  it("não troca quando o habitual não tem aquele horário", () => {
    const slots = [h(8, "dr1"), h(9, "dr3")];
    const r = umPorHorario(slots, "dr2");
    expect(r.map((s) => s.doctorId)).toEqual(["dr1", "dr3"]);
  });

  it("lida com lista vazia", () => {
    expect(umPorHorario([])).toEqual([]);
  });
});

// =========================================================
// Regras de horário (src/domain/horarios.ts)
// =========================================================
const TZ = "America/Sao_Paulo";
/** Domingo, 26/07/2026, 14:40 — o momento da conversa que motivou estes ajustes. */
const AGORA = DateTime.fromISO("2026-07-26T14:40", { zone: TZ }).toJSDate();

/** Um dia de agenda: 08:00 → 17:30, de 30 em 30 minutos. */
function diaCheio(data: string, doctorId = "dr1") {
  const slots = [];
  for (let m = 8 * 60; m < 18 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push({
      id: `${data}T${hh}:${mm}`,
      doctorId,
      startsAt: DateTime.fromISO(`${data}T${hh}:${mm}`, { zone: TZ }).toJSDate(),
    });
  }
  return slots;
}

const rotular = (s: { startsAt: Date }) =>
  DateTime.fromJSDate(s.startsAt).setZone(TZ).toFormat("dd/LL HH:mm");

const SEMANA_CHEIA = [
  ...diaCheio("2026-07-27"), // segunda
  ...diaCheio("2026-07-28"), // terça
  ...diaCheio("2026-07-29"), // quarta
];

describe("parseHoraPreferida", () => {
  it("entende minutos, e não só a hora cheia", () => {
    expect(parseHoraPreferida("16:30")).toBe(16 * 60 + 30);
    expect(parseHoraPreferida("16h30")).toBe(16 * 60 + 30);
    expect(parseHoraPreferida("08:05")).toBe(8 * 60 + 5);
  });

  it("aceita hora cheia em texto e o inteiro antigo", () => {
    expect(parseHoraPreferida("16")).toBe(16 * 60);
    expect(parseHoraPreferida("16h")).toBe(16 * 60);
    expect(parseHoraPreferida(22)).toBe(22 * 60);
  });

  it("devolve null para o que não é horário", () => {
    expect(parseHoraPreferida("")).toBeNull();
    expect(parseHoraPreferida(null)).toBeNull();
    expect(parseHoraPreferida("de tarde")).toBeNull();
    expect(parseHoraPreferida("25:00")).toBeNull();
  });
});

describe("resolverDia", () => {
  it("entende dia da semana", () => {
    expect(resolverDia("segunda", TZ, AGORA)).toEqual({ tipo: "semana", weekday: 1 });
    expect(resolverDia("segunda-feira", TZ, AGORA)).toEqual({ tipo: "semana", weekday: 1 });
    expect(resolverDia("sáb", TZ, AGORA)).toEqual({ tipo: "semana", weekday: 6 });
  });

  it("entende hoje, amanhã e depois de amanhã", () => {
    expect(resolverDia("hoje", TZ, AGORA)).toEqual({ tipo: "data", ano: 2026, mes: 7, dia: 26 });
    expect(resolverDia("amanhã", TZ, AGORA)).toEqual({ tipo: "data", ano: 2026, mes: 7, dia: 27 });
    expect(resolverDia("depois de amanhã", TZ, AGORA)).toEqual({
      tipo: "data",
      ano: 2026,
      mes: 7,
      dia: 28,
    });
  });

  it("entende datas", () => {
    expect(resolverDia("27/07", TZ, AGORA)).toEqual({ tipo: "data", ano: 2026, mes: 7, dia: 27 });
    expect(resolverDia("2026-07-27", TZ, AGORA)).toEqual({ tipo: "data", ano: 2026, mes: 7, dia: 27 });
  });

  it("dd/mm já passado neste ano cai no ano seguinte", () => {
    expect(resolverDia("10/01", TZ, AGORA)).toEqual({ tipo: "data", ano: 2027, mes: 1, dia: 10 });
  });

  it("devolve null quando não dá para entender", () => {
    expect(resolverDia("qualquer um", TZ, AGORA)).toBeNull();
    expect(resolverDia(undefined, TZ, AGORA)).toBeNull();
  });
});

describe("janelaAtendimento", () => {
  const seg_sex = { open: "08:00", close: "18:00" };

  it("não lista 'noite' numa clínica que fecha às 18h", () => {
    const j = janelaAtendimento(
      { 0: null, 1: seg_sex, 2: seg_sex, 3: seg_sex, 4: seg_sex, 5: seg_sex, 6: { open: "08:00", close: "12:00" } },
      30,
    );
    expect(j.periodos).toEqual(["manha", "tarde"]);
    expect(j.ultimoPorDia).toBe("seg, ter, qua, qui, sex: 17:30 · sáb: 11:30");
    expect(j.temAlgum).toBe(true);
  });

  it("lista 'noite' quando a agenda chega lá", () => {
    const j = janelaAtendimento({ 0: null, 1: { open: "08:00", close: "22:00" } }, 30);
    expect(j.periodos).toEqual(["manha", "tarde", "noite"]);
    expect(j.ultimoPorDia).toBe("seg: 21:30");
  });

  it("pula o intervalo de almoço ao contar os horários", () => {
    const j = janelaAtendimento(
      { 0: null, 1: { open: "08:00", close: "13:00", breakStart: "12:00", breakEnd: "13:00" } },
      30,
    );
    expect(j.ultimoPorDia).toBe("seg: 11:30");
    expect(j.periodos).toEqual(["manha"]);
  });

  it("aguenta agenda vazia", () => {
    const j = janelaAtendimento({}, 30);
    expect(j.periodos).toEqual([]);
    expect(j.temAlgum).toBe(false);
  });
});

describe("periodosGeraveis", () => {
  const manhaSo = { 0: null, 1: { open: "08:00", close: "12:00" } };
  const diaTodo = { 0: null, 1: { open: "08:00", close: "18:00" } };

  it("junta os períodos de todos os profissionais", () => {
    expect(periodosGeraveis([manhaSo, diaTodo], 30)).toEqual(["manha", "tarde"]);
  });

  it("um profissional só de manhã não inventa tarde", () => {
    expect(periodosGeraveis([manhaSo], 30)).toEqual(["manha"]);
  });

  it("almoço que engole a tarde tira a tarde da lista", () => {
    const comAlmocoLongo = {
      0: null,
      1: { open: "08:00", close: "18:00", breakStart: "12:00", breakEnd: "18:00" },
    };
    expect(periodosGeraveis([comAlmocoLongo], 30)).toEqual(["manha"]);
  });

  it("sem profissional, nenhum período", () => {
    expect(periodosGeraveis([], 30)).toEqual([]);
  });
});

describe("avisoPeriodoVazio", () => {
  const base = { periodo: "tarde" as const, especialidade: "Ortodontia", janelaDias: 30 };

  it('agenda sem o período: manda parar de oferecer e proíbe o "hoje não tem"', () => {
    const a = avisoPeriodoVazio({
      ...base,
      causa: { tipo: "fora-da-agenda", periodosReais: ["manha"] },
    });
    expect(a).toContain("NÃO tem tarde");
    expect(a).toContain("manhã");
    expect(a).toContain("hoje não tem"); // a instrução de NÃO dizer isso
    expect(a).toContain("NUNCA volte a oferecer");
  });

  it("tudo reservado: oferece a fila de espera, não nega o período", () => {
    const a = avisoPeriodoVazio({ ...base, causa: { tipo: "tudo-reservado" }, dia: "sexta-feira" });
    expect(a).toContain("reservados");
    expect(a).toContain("FILA DE ESPERA");
    expect(a).toContain("sexta-feira");
    expect(a).not.toContain("NÃO tem tarde");
  });

  it("sem profissional: manda mostrar as especialidades reais", () => {
    const a = avisoPeriodoVazio({ ...base, causa: { tipo: "sem-profissional" } });
    expect(a).toContain("listar_especialidades");
  });

  it("sem horário gerado: fala em janela de dias, sem prometer nem negar o período", () => {
    const a = avisoPeriodoVazio({ ...base, causa: { tipo: "sem-horario" } });
    expect(a).toContain("30 dias");
    expect(a).toContain("fila de espera");
  });
});

describe("escolherHorarios", () => {
  const base = { timezone: TZ, max: 3, agora: AGORA };

  it("REGRESSÃO: 16h30 na segunda oferece a própria segunda, não o mesmo horário em 3 dias", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, dia: "segunda", horaPreferida: "16:30" });
    expect(r.exato).toBe(true);
    expect(r.escolhidos.map(rotular)).toEqual(["27/07 16:30", "27/07 16:00", "27/07 17:00"]);
    expect(r.aviso).toBeUndefined();
  });

  it("horário pedido sem dia também fica num dia só", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, horaPreferida: "16:00" });
    expect(r.escolhidos.map(rotular)).toEqual(["27/07 16:00", "27/07 15:30", "27/07 16:30"]);
  });

  it("avisa quando o horário pedido não está livre e oferece os vizinhos", () => {
    const semDezesseisETrinta = SEMANA_CHEIA.filter((s) => rotular(s) !== "27/07 16:30");
    const r = escolherHorarios(semDezesseisETrinta, {
      ...base,
      dia: "segunda",
      horaPreferida: "16:30",
    });
    expect(r.exato).toBe(false);
    expect(r.aviso).toMatch(/16:30/);
    expect(r.escolhidos.map(rotular)).toEqual(["27/07 16:00", "27/07 17:00", "27/07 15:30"]);
  });

  it("respeita o dia pedido mesmo sem horário preferido", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, dia: "terça" });
    expect(r.escolhidos.map(rotular)).toEqual(["28/07 08:00", "28/07 08:30", "28/07 09:00"]);
    expect(r.exato).toBeNull();
  });

  it("completa com os dias seguintes quando o dia escolhido tem poucas opções", () => {
    const poucos = [
      ...diaCheio("2026-07-27").filter((s) => rotular(s) === "27/07 17:30"),
      ...diaCheio("2026-07-28"),
    ];
    const r = escolherHorarios(poucos, { ...base, horaPreferida: "17:30" });
    expect(r.escolhidos.map(rotular)).toEqual(["27/07 17:30", "28/07 17:30", "28/07 17:00"]);
  });

  it("filtra por período", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, periodo: "tarde", dia: "segunda" });
    expect(r.escolhidos.map(rotular)).toEqual(["27/07 12:00", "27/07 12:30", "27/07 13:00"]);
  });

  it("avisa quando não há período nenhum na agenda", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, periodo: "noite" });
    expect(r.escolhidos).toEqual([]);
    expect(r.aviso).toMatch(/noite/);
  });

  it("avisa quando o dia pedido não tem horário livre", () => {
    const r = escolherHorarios(SEMANA_CHEIA, { ...base, dia: "domingo" });
    expect(r.escolhidos).toEqual([]);
    expect(r.aviso).toMatch(/domingo/);
  });

  it("mantém a continuidade do profissional habitual", () => {
    const doisMedicos = [...diaCheio("2026-07-27", "dr1"), ...diaCheio("2026-07-27", "dr2")];
    const r = escolherHorarios(doisMedicos, { ...base, dia: "segunda", profissionalHabitual: "dr2" });
    expect(r.escolhidos.every((s) => s.doctorId === "dr2")).toBe(true);
  });
});
