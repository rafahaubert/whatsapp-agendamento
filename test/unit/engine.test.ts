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
const marcarComparecimento = vi.fn();
vi.mock("../../src/domain/scheduling.js", () => ({
  confirmAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  marcarComparecimento: (...a: unknown[]) => marcarComparecimento(...a),
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
    expect(saida?.[5]).toEqual({ input: 100, output: 20, cacheCreation: 0, cacheRead: 0 });
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
    expect(saida?.[5]).toEqual({ input: 800, output: 100, cacheCreation: 0, cacheRead: 0 });
  });

  it("registra o consumo mesmo quando o turno falha", async () => {
    criarMensagem.mockRejectedValue(new Error("503"));

    const reply = await conversationEngine.handle([msg("oi")]);

    expect(reply?.texto).toBe("Não entendi.");
    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[5]).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
  });

  // As faixas de cache têm preços diferentes do input normal (1,25x na escrita,
  // 0,1x na leitura). Se elas se perderem aqui, o painel calcula um custo errado.
  it("separa escrita e leitura de cache do input normal", async () => {
    criarMensagem
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu1", name: "listar_especialidades", input: {} }],
        stop_reason: "tool_use",
        // Primeira ida ao modelo: grava o prefixo no cache.
        usage: {
          input_tokens: 40,
          output_tokens: 10,
          cache_creation_input_tokens: 3500,
          cache_read_input_tokens: 0,
        },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Temos várias opções." }],
        stop_reason: "end_turn",
        // Segunda: lê o mesmo prefixo, a 10% do preço.
        usage: {
          input_tokens: 60,
          output_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 3500,
        },
      });
    executarFerramenta.mockResolvedValue([]);

    await conversationEngine.handle([msg("o que vocês atendem?")]);

    const saida = logMessage.mock.calls.find((c) => c[2] === "OUT");
    expect(saida?.[5]).toEqual({
      input: 100,
      output: 35,
      cacheCreation: 3500,
      cacheRead: 3500,
    });
  });

  it("manda o system como bloco cacheável", async () => {
    await conversationEngine.handle([msg("oi")]);

    const chamada = criarMensagem.mock.calls[0][0] as {
      system: { type: string; text: string; cache_control?: { type: string } }[];
    };
    expect(chamada.system).toEqual([
      { type: "text", text: "system de teste", cache_control: { type: "ephemeral" } },
    ]);
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

// ---------------------------------------------------------------------------
// Forma da requisição por modelo
// ---------------------------------------------------------------------------
// Omitir `thinking` significa "sem pensar" num modelo e "pensamento adaptativo"
// noutro, e `max_tokens` é o teto de pensamento + texto SOMADOS. Trocar o modelo
// no painel passava a truncar a resposta ao paciente sem nenhum aviso.
describe("configuração do modelo na requisição", () => {
  /** A requisição que o motor montou na última chamada. */
  async function requisicao(modelo: string) {
    const tenant = fakeTenant();
    tenant.config.ai.model = modelo;
    await conversationEngine.handle([msg("oi", tenant)]);
    const [[params]] = criarMensagem.mock.calls as [
      [
        {
          model: string;
          max_tokens: number;
          thinking?: { type: string };
          output_config?: { effort: string };
          system: { cache_control?: unknown }[];
        },
      ],
    ];
    return params;
  }

  it("nunca depende do default de pensamento", async () => {
    for (const m of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-5"]) {
      vi.clearAllMocks();
      criarMensagem.mockResolvedValue(respostaSimples("ok"));
      const p = await requisicao(m);
      expect(p.thinking, m).toBeDefined();
    }
  });

  it("desliga o pensamento no Haiku, que não pensa por padrão", async () => {
    const p = await requisicao("claude-haiku-4-5");
    expect(p.thinking).toEqual({ type: "disabled" });
    expect(p.output_config).toBeUndefined(); // o Haiku 4.5 erra se receber `effort`
    expect(p.max_tokens).toBe(1024);
  });

  // REGRESSÃO: com max_tokens em 1024 e pensamento ligado, o teto era dividido
  // entre pensar e responder — e a resposta ao paciente saía cortada.
  it("dá teto maior a quem pensa", async () => {
    for (const m of ["claude-sonnet-5", "claude-opus-5"]) {
      vi.clearAllMocks();
      criarMensagem.mockResolvedValue(respostaSimples("ok"));
      const p = await requisicao(m);
      expect(p.thinking, m).toEqual({ type: "adaptive" });
      expect(p.output_config, m).toEqual({ effort: "low" });
      expect(p.max_tokens, m).toBeGreaterThan(1024);
    }
  });

  it("modelo desconhecido na config não quebra a conversa", async () => {
    const p = await requisicao("claude-modelo-aposentado");
    expect(p.model).toBe("claude-modelo-aposentado"); // vai como está: quem decide é a API
    expect(p.thinking).toEqual({ type: "disabled" }); // mas o perfil cai no padrão
  });

  it("o breakpoint de cache continua no system", async () => {
    const p = await requisicao("claude-haiku-4-5");
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

// ---------------------------------------------------------------------------
// Desfecho respondido pelo paciente
// ---------------------------------------------------------------------------
describe("botões de desfecho da consulta", () => {
  function msgBotao(payload: string, titulo: string): IncomingMessage {
    return { ...msg(titulo), payload };
  }

  // A taxa de falta é o número que sustenta a renovação. Antes só fechava se a
  // recepção clicasse no painel; agora o próprio paciente responde num toque —
  // e o motor resolve sem gastar uma ida ao modelo.
  it("VEIO marca comparecimento sem chamar o modelo", async () => {
    marcarComparecimento.mockResolvedValue({ status: "COMPARECEU" });

    const reply = await conversationEngine.handle([msgBotao("VEIO:appt-1", "Sim, fui")]);

    expect(marcarComparecimento).toHaveBeenCalledWith(expect.anything(), "appt-1", true);
    expect(criarMensagem).not.toHaveBeenCalled();
    expect(reply?.texto).toMatch(/obrigado por confirmar/i);
  });

  it("FALTEI marca falta e oferece remarcar", async () => {
    marcarComparecimento.mockResolvedValue({ status: "FALTOU" });

    const reply = await conversationEngine.handle([msgBotao("FALTEI:appt-2", "Não consegui")]);

    expect(marcarComparecimento).toHaveBeenCalledWith(expect.anything(), "appt-2", false);
    expect(criarMensagem).not.toHaveBeenCalled();
    expect(reply?.texto).toMatch(/remarque|remarcar/i);
  });

  it("agendamento inexistente devolve o erro, não uma confirmação falsa", async () => {
    marcarComparecimento.mockResolvedValue({ erro: "Agendamento não encontrado." });

    const reply = await conversationEngine.handle([msgBotao("VEIO:sumiu", "Sim, fui")]);

    expect(reply?.texto).toBe("Agendamento não encontrado.");
  });
});
