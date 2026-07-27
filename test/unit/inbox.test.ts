import { describe, it, expect, vi, afterEach } from "vitest";
import {
  agruparMensagem,
  chaveConversa,
  enfileirar,
  limparCaixaDeEntrada,
} from "../../src/core/inbox.js";
import type { IncomingMessage } from "../../src/channels/types.js";

const msg = (text: string, payload?: string) =>
  ({ text, payload, from: "+5551999999999" }) as unknown as IncomingMessage;

afterEach(() => {
  limparCaixaDeEntrada();
  vi.useRealTimers();
});

describe("agruparMensagem", () => {
  it("REGRESSÃO: duas mensagens seguidas viram UM lote, não duas respostas", async () => {
    vi.useFakeTimers();
    const lotes: string[][] = [];
    const processar = async (m: IncomingMessage[]) => {
      lotes.push(m.map((x) => x.text ?? ""));
    };

    agruparMensagem("c1", msg("teria que ser um pouco mais tarde"), 8000, processar);
    await vi.advanceTimersByTimeAsync(2000);
    agruparMensagem("c1", msg("me manda outras opções"), 8000, processar);

    // A segunda mensagem reinicia a espera: 7,9 s depois ainda não respondeu.
    await vi.advanceTimersByTimeAsync(7900);
    expect(lotes).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(lotes).toEqual([["teria que ser um pouco mais tarde", "me manda outras opções"]]);
  });

  it("clique numa opção não espera", async () => {
    vi.useFakeTimers();
    const lotes: string[][] = [];
    const processar = async (m: IncomingMessage[]) => {
      lotes.push(m.map((x) => x.text ?? ""));
    };

    agruparMensagem("c2", msg("oi"), 8000, processar);
    await vi.advanceTimersByTimeAsync(500);
    expect(lotes).toEqual([]);

    agruparMensagem("c2", msg("seg., 27/07, 16:00", "SLOT:abc"), 8000, processar);
    await vi.advanceTimersByTimeAsync(1);
    expect(lotes).toEqual([["oi", "seg., 27/07, 16:00"]]);
  });

  it("conversas diferentes não se misturam", async () => {
    vi.useFakeTimers();
    const lotes: Record<string, string[]> = {};
    const processarDe = (chave: string) => async (m: IncomingMessage[]) => {
      lotes[chave] = m.map((x) => x.text ?? "");
    };

    agruparMensagem("a", msg("sou a"), 1000, processarDe("a"));
    agruparMensagem("b", msg("sou b"), 1000, processarDe("b"));
    await vi.advanceTimersByTimeAsync(1000);

    expect(lotes).toEqual({ a: ["sou a"], b: ["sou b"] });
  });

  it("monta a chave por clínica + telefone", () => {
    expect(chaveConversa("t1", "+5551999999999")).toBe("t1:+5551999999999");
    expect(chaveConversa("t1", "+555188888888")).not.toBe(chaveConversa("t2", "+555188888888"));
  });
});

describe("enfileirar", () => {
  it("REGRESSÃO: roda um lote por vez na mesma conversa (nada de execução paralela)", async () => {
    const ordem: string[] = [];
    let liberar!: () => void;
    const travado = new Promise<void>((r) => {
      liberar = r;
    });

    const p1 = enfileirar("c3", async () => {
      ordem.push("inicio-1");
      await travado;
      ordem.push("fim-1");
    });
    const p2 = enfileirar("c3", async () => {
      ordem.push("inicio-2");
    });

    await Promise.resolve();
    expect(ordem).toEqual(["inicio-1"]); // o segundo nem começou

    liberar();
    await Promise.all([p1, p2]);
    expect(ordem).toEqual(["inicio-1", "fim-1", "inicio-2"]);
  });

  it("uma falha não trava a fila", async () => {
    const ordem: string[] = [];
    const p1 = enfileirar("c4", async () => {
      ordem.push("um");
      throw new Error("boom");
    });
    const p2 = enfileirar("c4", async () => {
      ordem.push("dois");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(ordem).toEqual(["um", "dois"]);
  });

  it("chaves diferentes rodam em paralelo", async () => {
    const ordem: string[] = [];
    let liberar!: () => void;
    const travado = new Promise<void>((r) => {
      liberar = r;
    });

    const p1 = enfileirar("x", async () => {
      ordem.push("x-inicio");
      await travado;
    });
    const p2 = enfileirar("y", async () => {
      ordem.push("y");
    });

    await p2;
    expect(ordem).toEqual(["x-inicio", "y"]);
    liberar();
    await p1;
  });
});
