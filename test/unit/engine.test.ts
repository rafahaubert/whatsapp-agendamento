/**
 * Motor de conversa — os pontos que já custaram caro em produção:
 * silêncio durante atendimento humano, ordem das escritas no handoff,
 * registro do consumo de tokens e o rate limit por conversa.
 *
 * Tudo que fala com o mundo (Claude, banco, mídia) entra mockado: o que
 * interessa aqui é a decisão do motor, não a integração.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "../../src/channels/types.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";

// ---------- Mocks ----------
const criarMensagem = vi.fn();
vi.mock("../../src/ai/anthropic.js", () => ({
  anthropic: { messages: { create: (...a: unknown[]) => criarMensagem(...a) } },
}));

vi.mock("../../src/ai/systemPrompt.js", () => ({
  buildSystemPrompt: () => "system de teste",
}));

const executarFerramenta = vi.fn();
vi.mock("../../src/ai/tools.js", () => ({
  buildTools: () => [],
  executeTool: (...a: unknown[]) => executarFerramenta(...a),
}));

const loadConversation = vi.fn();
const saveConversation = vi.fn();
const setHandoff = vi.fn();
const logMessage = vi.fn();
vi.mock("../../src/db/conversationRepository.js", () => ({
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  saveConversation: (...a: unknown[]) => saveConversation(...a),
  setHandoff: (...a: unknown[]) => setHandoff(...a),
  logMessage: (...a: unknown[]) => logMessage(...a),
}));

// O logger real carrega config/env.js, que valida as variáveis e chama
// process.exit — teste de unidade não tem (nem quer) o ambiente completo.
vi.mock("../../src/shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/channels/whatsapp/media.js", () => ({ baixarMidia: vi.fn() }));
vi.mock("../../src/integrations/transcription.js", () => ({
  transcreverAudio: vi.fn(),
  isTranscricaoConfigurada: () => false,
}));
const pacientesDoTelefone = vi.fn();
vi.mock("../../src/domain/scheduling.js", () => ({
  confirmAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  periodosReaisDaAgenda: vi.fn(async () => []),
  pacientesDoTelefone: (...a: unknown[]) => pacientesDoTelefone(...a),
}));

const { conversationEngine, limparRateLimit } = await import("../../src/core/engine.js");

// ---------- Fixtures ----------
function fakeTenant(id = "t1"): ResolvedTenant {
  return {
    id,
    slug: `clinica-${id}`,
    name: "Clínica Teste",
    timezone: "America/Sao_Paulo",
    whatsappPhoneNumberId: "123",
    config: {
      branding: {
        clinicName: "Clínica Teste",
        greetingMessage: "Olá!",
        fallbackMessage: "Não entendi.",
        closingMessage: "Até breve!",
      },
      businessHours: { timezone: "America/Sao_Paulo", days: { 1: { open: "08:00", close: "18:00" } } },
      booking: {
        slotDurationMinutes: 30,
        maxOptionsOffered: 3,
        advanceBookingDays: 30,
        allowCancellation: true,
        allowReschedule: true,
        askInsurance: true,
        acceptParticular: true,
      },
      ai: { model: "claude-haiku-4-5", persona: "Cordial." },
    },
  };
}

function msg(texto: string, tenant = fakeTenant(), from = "5511999990000"): IncomingMessage {
  return {
    channel: "whatsapp",
    tenant,
    from,
    messageId: `m-${Math.random()}`,
    timestamp: new Date(),
    text: texto,
    tipo: "text",
  };
}

/** Resposta do Claude sem tool use. */
function respostaSimples(texto: string, input = 100, output = 20) {
  return {
    content: [{ type: "text", text: texto }],
    stop_reason: "end_turn",
    usage: { input_tokens: input, output_tokens: output },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limparRateLimit();
  loadConversation.mockResolvedValue({ history: [], state: {}, humanHandoff: false });
  saveConversation.mockResolvedValue(undefined);
  setHandoff.mockResolvedValue(undefined);
  logMessage.mockResolvedValue(undefined);
  pacientesDoTelefone.mockResolvedValue([]);
  criarMensagem.mockResolvedValue(respostaSimples("Oi! Como posso ajudar?"));
});

/** Turno que busca horários e termina com o texto dado. */
function turnoComHorarios(textoFinal: string) {
  criarMensagem
    .mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "tu1", name: "listar_horarios", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    })
    .mockResolvedValueOnce(respostaSimples(textoFinal));
  executarFerramenta.mockResolvedValue({
    horarios: [
      { slotId: "s1", medico: "Dr. Arnaldo", unidade: "Centro", inicio: "sex., 31/07, 15:30" },
      { slotId: "s2", medico: "Dr. Arnaldo", unidade: "Centro", inicio: "sex., 31/07, 16:00" },
    ],
  });
}

describe("opções clicáveis no pedido de confirmação", () => {
  // O paciente trocou de profissional mantendo o horário; o agente buscou a
  // agenda de novo e o motor devolveu os três horários DEBAIXO do "Posso
  // confirmar?" — como se a escolha dele tivesse se perdido.
  it("REGRESSÃO: não reoferece a agenda junto do 'Posso confirmar?'", async () => {
    turnoComHorarios(
      "Confirmando então:\n\n*Clínico Geral* | *Dr. Arnaldo Pereira* | *Sexta, 31/07 às 15:30*\n\nPosso confirmar?",
    );

    const reply = await conversationEngine.handle([msg("troque para o dr Arnaldo")]);

    expect(reply?.opcoes?.map((o) => o.titulo)).toEqual(["Sim, pode agendar", "Quero outro horário"]);
  });

  // "Confirmando então: ... agendado!" não pede mais nada — a consulta já saiu.
  it("depois de agendar, não sobra pergunta de confirmação para responder", async () => {
    criarMensagem
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu1", name: "agendar", input: { slotId: "s1" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce(respostaSimples("Confirmando então: está agendado! Posso confirmar mais alguma coisa?"));
    executarFerramenta.mockResolvedValue({ status: "AGENDADO" });

    const reply = await conversationEngine.handle([msg("sim, pode agendar")]);

    expect(reply?.opcoes).toBeUndefined();
  });

  it("oferecendo horários de verdade, os botões continuam sendo os horários", async () => {
    turnoComHorarios("Tenho estes horários com o Dr. Arnaldo 👇");

    const reply = await conversationEngine.handle([msg("tem mais tarde?")]);

    expect(reply?.opcoes?.map((o) => o.titulo)).toEqual([
      "sex., 31/07, 15:30",
      "sex., 31/07, 16:00",
    ]);
  });
});

describe("paciente já cadastrado no telefone", () => {
  it("entra na conversa já identificado, sem pedir nome e CPF", async () => {
    pacientesDoTelefone.mockResolvedValue([{ id: "p1", name: "Josué Santana" }]);

    await conversationEngine.handle([msg("oi")]);

    expect(saveConversation).toHaveBeenCalledWith("t1", "5511999990000", expect.anything(), {
      patientId: "p1",
    });
  });

  // Telefone de família: quem escolhe para quem é a consulta é o paciente.
  it("com mais de um cadastro no número, não escolhe por conta própria", async () => {
    pacientesDoTelefone.mockResolvedValue([
      { id: "p1", name: "Josué Santana" },
      { id: "p2", name: "Maria Santana" },
    ]);

    await conversationEngine.handle([msg("oi")]);

    expect(saveConversation).toHaveBeenCalledWith("t1", "5511999990000", expect.anything(), {
      patientId: undefined,
    });
  });

  it("uma falha na leitura do cadastro não derruba o atendimento", async () => {
    pacientesDoTelefone.mockRejectedValue(new Error("db fora"));

    const reply = await conversationEngine.handle([msg("oi")]);

    expect(reply?.texto).toBe("Oi! Como posso ajudar?");
  });
});

describe("atendimento humano", () => {
  it("não responde nada enquanto a conversa está com a recepção", async () => {
    loadConversation.mockResolvedValue({ history: [], state: {}, humanHandoff: true });

    const reply = await conversationEngine.handle([msg("oi")]);

    expect(reply).toBeNull();
    expect(criarMensagem).not.toHaveBeenCalled();
  });

  it("grava o handoff ANTES do histórico", async () => {
    // A ferramenta chamar_atendente liga ctx.handoffRequested.
    criarMensagem
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu1", name: "chamar_atendente", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .mockResolvedValueOnce(respostaSimples("Já chamei a recepção."));
    executarFerramenta.mockImplementation(async (_nome, _input, ctx) => {
      (ctx as { handoffRequested?: boolean }).handoffRequested = true;
      return { ok: true };
    });

    await conversationEngine.handle([msg("quero falar com alguém por favor")]);

    expect(setHandoff).toHaveBeenCalledWith("t1", "5511999990000", true);
    const ordemHandoff = setHandoff.mock.invocationCallOrder[0];
    const ordemSave = saveConversation.mock.invocationCallOrder[0];
    expect(ordemHandoff).toBeLessThan(ordemSave);
  });

  it("atalho de 'atendente' silencia o bot sem gastar LLM", async () => {
    await conversationEngine.handle([msg("atendente")]);
    expect(setHandoff).toHaveBeenCalledWith("t1", "5511999990000", true);
    expect(criarMensagem).not.toHaveBeenCalled();
  });
});

describe("consumo de tokens", () => {
  it("registra o consumo na resposta bem-sucedida", async () => {
    await conversationEngine.handle([msg("oi")]);

    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[5]).toEqual({ input: 100, output: 20 });
  });

  it("soma o consumo de todas as idas ao modelo no turno", async () => {
    criarMensagem
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu1", name: "listar_especialidades", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 300, output_tokens: 40 },
      })
      .mockResolvedValueOnce(respostaSimples("Temos várias opções.", 500, 60));
    executarFerramenta.mockResolvedValue([]);

    await conversationEngine.handle([msg("o que vocês atendem?")]);

    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[5]).toEqual({ input: 800, output: 100 });
  });

  it("registra o consumo mesmo quando o turno falha", async () => {
    criarMensagem.mockRejectedValue(new Error("503"));

    const reply = await conversationEngine.handle([msg("oi")]);

    expect(reply?.texto).toBe("Não entendi.");
    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[5]).toEqual({ input: 0, output: 0 });
  });
});

describe("rate limit", () => {
  const LIMITE = 10;

  async function enviar(n: number, tenant = fakeTenant(), from = "5511999990000") {
    const respostas = [];
    for (let i = 0; i < n; i++) {
      respostas.push(await conversationEngine.handle([msg(`msg ${i}`, tenant, from)]));
    }
    return respostas;
  }

  it("avisa uma única vez por janela em vez de a cada mensagem", async () => {
    await enviar(LIMITE);
    const excedentes = await enviar(4);

    expect(excedentes[0]?.texto).toContain("muitas mensagens");
    // As seguintes são engolidas: repetir o aviso custa envio e parece bug.
    expect(excedentes.slice(1)).toEqual([null, null, null]);
  });

  it("o aviso de excesso também entra na caixa de entrada da clínica", async () => {
    await enviar(LIMITE);
    logMessage.mockClear();
    await enviar(1);

    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[3]).toContain("muitas mensagens");
  });

  it("REGRESSÃO: silencia em vez de avisar quando há atendimento humano", async () => {
    await enviar(LIMITE);
    loadConversation.mockResolvedValue({ history: [], state: {}, humanHandoff: true });

    expect(await enviar(1)).toEqual([null]);
  });

  it("REGRESSÃO: a janela é por (clínica, telefone), não só por telefone", async () => {
    const clinicaA = fakeTenant("t1");
    const clinicaB = fakeTenant("t2");
    const mesmoPaciente = "5511999990000";

    await enviar(LIMITE, clinicaA, mesmoPaciente);
    // O mesmo número falando com OUTRA clínica não pode herdar o bloqueio.
    const naOutra = await enviar(1, clinicaB, mesmoPaciente);

    expect(naOutra[0]?.texto).toBe("Oi! Como posso ajudar?");
  });

  it("não bloqueia quem fica abaixo do limite", async () => {
    const respostas = await enviar(LIMITE);
    expect(respostas.every((r) => r?.texto === "Oi! Como posso ajudar?")).toBe(true);
  });
});

describe("config com fuso inválido", () => {
  it("não derruba o lote — responde usando UTC", async () => {
    const tenant = fakeTenant();
    tenant.config.businessHours.timezone = "Marte/Olympus";

    const reply = await conversationEngine.handle([msg("oi", tenant)]);

    expect(reply?.texto).toBe("Oi! Como posso ajudar?");
    const [[params]] = criarMensagem.mock.calls as [[{ messages: { content: string }[] }]];
    expect(params.messages[0].content).toContain("Fuso: UTC");
  });
});
