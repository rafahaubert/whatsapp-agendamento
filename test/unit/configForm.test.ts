import { describe, it, expect } from "vitest";
import { parseConfig, blocosDoCorpo, type Bloco } from "../../src/admin/configForm.js";
import type { TenantConfig } from "../../src/config/types.js";

const atual: TenantConfig = {
  branding: {
    clinicName: "Clínica Vida",
    greetingMessage: "Olá! Como posso ajudar?",
    fallbackMessage: "Não entendi.",
    closingMessage: "Até logo!",
  },
  businessHours: {
    timezone: "America/Sao_Paulo",
    days: {
      0: null,
      1: { open: "08:00", close: "18:00", breakStart: "12:00", breakEnd: "13:00" },
      2: { open: "08:00", close: "18:00" },
      3: { open: "08:00", close: "18:00" },
      4: { open: "08:00", close: "18:00" },
      5: { open: "08:00", close: "18:00" },
      6: null,
    },
  },
  booking: {
    slotDurationMinutes: 45,
    maxOptionsOffered: 3,
    advanceBookingDays: 60,
    allowCancellation: true,
    allowReschedule: true,
    askInsurance: true,
    acceptParticular: true,
  },
  ai: { model: "claude-sonnet-5", persona: "Cordial e objetiva." },
  debounceSeconds: 8,
  knowledgeBase: "Aceitamos PIX e cartão.",
  reminders: { enabled: true, hoursBefore: 24, templateName: "lembrete", templateLang: "pt_BR" },
  waitlist: { enabled: true, templateName: "vaga", templateLang: "pt_BR" },
  recall: { enabled: true, months: 6, templateName: "retorno", templateLang: "pt_BR" },
};

const TZ = "America/Sao_Paulo";

describe("blocosDoCorpo", () => {
  it("lê os blocos declarados e ignora nome desconhecido", () => {
    expect(blocosDoCorpo({ _blocos: "mensagens horario inventado" })).toEqual([
      "mensagens",
      "horario",
    ]);
  });

  it("corpo sem _blocos não declara bloco nenhum", () => {
    expect(blocosDoCorpo({})).toEqual([]);
    expect(blocosDoCorpo(undefined)).toEqual([]);
  });
});

describe("parseConfig — mesclagem por bloco", () => {
  // O ponto central: o formulário de uma página não pode apagar o que é editado
  // em outra. Caixa desmarcada e campo ausente chegam idênticos no POST.
  it("salvar só as mensagens preserva lembrete, fila e reativação", () => {
    const nova = parseConfig(
      {
        _blocos: "mensagens",
        branding_greeting: "Bom dia!",
        branding_fallback: "Pode repetir?",
        branding_closing: "Obrigado!",
      },
      TZ,
      atual,
      ["mensagens"],
    );

    expect(nova.branding.greetingMessage).toBe("Bom dia!");
    expect(nova.reminders).toEqual(atual.reminders);
    expect(nova.waitlist).toEqual(atual.waitlist);
    expect(nova.recall).toEqual(atual.recall);
  });

  it("salvar só as mensagens não fecha a clínica na semana toda", () => {
    const nova = parseConfig({ _blocos: "mensagens" }, TZ, atual, ["mensagens"]);
    expect(nova.businessHours.days).toEqual(atual.businessHours.days);
    expect(nova.businessHours.days[1]).not.toBeNull();
  });

  it("salvar só o horário não zera regras, IA nem FAQ", () => {
    const nova = parseConfig(
      { _blocos: "horario", day_1_aberto: "on", day_1_open: "09:00", day_1_close: "17:00" },
      TZ,
      atual,
      ["horario"],
    );

    expect(nova.businessHours.days[1]).toEqual({ open: "09:00", close: "17:00" });
    expect(nova.businessHours.days[2]).toBeNull(); // não veio no corpo = fechado
    expect(nova.booking).toEqual(atual.booking);
    expect(nova.ai).toEqual(atual.ai);
    expect(nova.knowledgeBase).toBe(atual.knowledgeBase);
  });

  it("desmarcar uma caixa DENTRO do bloco declarado desliga de verdade", () => {
    const nova = parseConfig(
      { _blocos: "lembrete", reminders_hoursBefore: "48", reminders_templateName: "lembrete" },
      TZ,
      atual,
      ["lembrete"],
    );

    expect(nova.reminders?.enabled).toBe(false);
    expect(nova.reminders?.hoursBefore).toBe(48);
    // e não encosta nos vizinhos
    expect(nova.waitlist?.enabled).toBe(true);
    expect(nova.recall?.enabled).toBe(true);
  });

  it("bloco não declarado é ignorado mesmo se o campo vier no corpo", () => {
    const nova = parseConfig(
      { _blocos: "mensagens", branding_greeting: "Oi", recall_months: "99" },
      TZ,
      atual,
      ["mensagens"],
    );
    expect(nova.recall?.months).toBe(6);
  });

  it("o fuso em vigor sempre espelha no businessHours", () => {
    const nova = parseConfig({ _blocos: "mensagens" }, "America/Bahia", atual, ["mensagens"]);
    expect(nova.businessHours.timezone).toBe("America/Bahia");
    expect(nova.businessHours.days).toEqual(atual.businessHours.days);
  });

  it("sem bloco algum, a configuração sai intacta", () => {
    const nova = parseConfig({}, TZ, atual, [] as Bloco[]);
    expect(nova).toEqual(atual);
  });

  it("intervalo de almoço só entra com as duas pontas preenchidas", () => {
    const meio = parseConfig(
      {
        _blocos: "horario",
        day_1_aberto: "on",
        day_1_open: "08:00",
        day_1_close: "18:00",
        day_1_break_start: "12:00",
        day_1_break_end: "",
      },
      TZ,
      atual,
      ["horario"],
    );
    expect(meio.businessHours.days[1]).toEqual({ open: "08:00", close: "18:00" });

    const completo = parseConfig(
      {
        _blocos: "horario",
        day_1_aberto: "on",
        day_1_open: "08:00",
        day_1_close: "18:00",
        day_1_break_start: "12:00",
        day_1_break_end: "13:00",
      },
      TZ,
      atual,
      ["horario"],
    );
    expect(completo.businessHours.days[1]).toEqual({
      open: "08:00",
      close: "18:00",
      breakStart: "12:00",
      breakEnd: "13:00",
    });
  });
});
