import { describe, it, expect } from "vitest";
import { umPorHorario } from "../../src/domain/scheduling.js";

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
