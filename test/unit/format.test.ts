import { describe, it, expect } from "vitest";
import { semOpcoesRepetidas } from "../../src/channels/format.js";

const OPCOES = [
  { id: "SLOT:a", titulo: "seg., 27/07, 12:00" },
  { id: "SLOT:b", titulo: "seg., 27/07, 12:30" },
  { id: "SLOT:c", titulo: "seg., 27/07, 13:00" },
];

describe("semOpcoesRepetidas", () => {
  // O caso real: a mensagem trazia a lista numerada e, logo abaixo, os mesmos
  // horários como botões.
  it("remove a lista numerada que repete os botões", () => {
    const texto = [
      "Por enquanto só tenho horários na segunda-feira (27/07) à tarde com a Dra. Ana da Silva:",
      "",
      "1. 12:00",
      "2. 12:30",
      "3. 13:00",
      "",
      "Quer algum desses?",
    ].join("\n");

    expect(semOpcoesRepetidas(texto, OPCOES)).toBe(
      "Por enquanto só tenho horários na segunda-feira (27/07) à tarde com a Dra. Ana da Silva:\n\nQuer algum desses?",
    );
  });

  it("remove também marcadores e o horário escrito por extenso", () => {
    const texto = "Tenho:\n- 12h\n• seg., 27/07, 12:30\n* 13:00\nQual prefere?";
    expect(semOpcoesRepetidas(texto, OPCOES)).toBe("Tenho:\nQual prefere?");
  });

  it("mantém a linha quando ela diz algo além do horário", () => {
    const texto = "Opções:\n1. 12:00 com a Dra. Ana\n2. 12:30";
    expect(semOpcoesRepetidas(texto, OPCOES)).toBe("Opções:\n1. 12:00 com a Dra. Ana");
  });

  it("não mexe em texto sem lista", () => {
    const texto = "Tenho estes horários com a Dra. Ana 👇";
    expect(semOpcoesRepetidas(texto, OPCOES)).toBe(texto);
  });

  it("preserva listas que não são de horários", () => {
    const texto = "Especialidades:\n1. Ortodontia\n2. Implante";
    expect(semOpcoesRepetidas(texto, OPCOES)).toBe(texto);
  });

  // WhatsApp recusa corpo vazio: melhor duplicar do que não enviar nada.
  it("devolve o texto original se sobrar só a lista", () => {
    const texto = "1. 12:00\n2. 12:30\n3. 13:00";
    expect(semOpcoesRepetidas(texto, OPCOES)).toBe(texto);
  });

  it("sem opções, não altera nada", () => {
    expect(semOpcoesRepetidas("1. 12:00", [])).toBe("1. 12:00");
  });
});
