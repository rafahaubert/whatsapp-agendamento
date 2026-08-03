import { describe, it, expect } from "vitest";
import {
  chavePixValida,
  crc16,
  formatarValor,
  gerarCopiaECola,
  normalizarChave,
  normalizarTexto,
} from "../../src/domain/pix.js";

describe("crc16", () => {
  // Vetor de verificação canônico do CRC16-CCITT-FALSE: "123456789" → 0x29B1.
  // Trocar por outra variante de CRC16 (ARC, XMODEM, MODBUS) gera um código que
  // o banco recusa sem dizer por quê — é por isso que este teste existe.
  it("bate com o vetor de verificação do CCITT-FALSE", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("devolve sempre quatro dígitos hexadecimais maiúsculos", () => {
    for (const s of ["", "a", "pix", "6304", "A".repeat(200)]) {
      expect(crc16(s)).toMatch(/^[0-9A-F]{4}$/);
    }
  });
});

describe("normalizarTexto", () => {
  // Acento passa pelo gerador e quebra na leitura de alguns bancos.
  it("tira acento e sobe para maiúsculo", () => {
    expect(normalizarTexto("Clínica São José", 25)).toBe("CLINICA SAO JOSE");
    expect(normalizarTexto("Ribeirão Preto", 15)).toBe("RIBEIRAO PRETO");
  });

  it("corta no tamanho máximo do campo", () => {
    expect(normalizarTexto("A".repeat(40), 25)).toHaveLength(25);
    expect(normalizarTexto("Belo Horizonte Minas", 15)).toHaveLength(15);
  });

  it("descarta o que o padrão não prevê", () => {
    expect(normalizarTexto("Clínica #1 (Centro)", 25)).toBe("CLINICA 1 CENTRO");
  });
});

describe("normalizarChave", () => {
  it("CPF e CNPJ vão só com dígitos", () => {
    expect(normalizarChave("123.456.789-09", "cpf")).toBe("12345678909");
    expect(normalizarChave("12.345.678/0001-95", "cnpj")).toBe("12345678000195");
  });

  // O erro mais comum: cadastrar o telefone sem o código do país.
  it("telefone vai em E.164, com o 55 na frente", () => {
    expect(normalizarChave("(51) 99999-8888", "telefone")).toBe("+5551999998888");
    expect(normalizarChave("5551999998888", "telefone")).toBe("+5551999998888");
    expect(normalizarChave("+55 51 99999-8888", "telefone")).toBe("+5551999998888");
  });

  it("e-mail e chave aleatória vão em minúsculo", () => {
    expect(normalizarChave("Contato@Clinica.COM", "email")).toBe("contato@clinica.com");
    expect(normalizarChave(" ABC-123 ", "aleatoria")).toBe("abc-123");
  });
});

describe("formatarValor", () => {
  it("usa ponto decimal e duas casas", () => {
    expect(formatarValor(15000)).toBe("150.00");
    expect(formatarValor(15050)).toBe("150.50");
    expect(formatarValor(5)).toBe("0.05");
  });
});

describe("gerarCopiaECola", () => {
  const base = {
    chave: "contato@clinica.com",
    tipo: "email" as const,
    beneficiario: "Clínica Exemplo",
    cidade: "Novo Hamburgo",
  };

  /** Lê um campo TLV de primeiro nível do payload. */
  function campoDe(payload: string, tag: string): string | null {
    let i = 0;
    while (i < payload.length - 4) {
      const t = payload.slice(i, i + 2);
      const len = Number(payload.slice(i + 2, i + 4));
      const valor = payload.slice(i + 4, i + 4 + len);
      if (t === tag) return valor;
      i += 4 + len;
    }
    return null;
  }

  it("monta os campos obrigatórios do BR Code", () => {
    const p = gerarCopiaECola(base);
    expect(campoDe(p, "00")).toBe("01"); // formato do payload
    expect(campoDe(p, "53")).toBe("986"); // real
    expect(campoDe(p, "58")).toBe("BR");
    expect(campoDe(p, "59")).toBe("CLINICA EXEMPLO");
    expect(campoDe(p, "60")).toBe("NOVO HAMBURGO");
    expect(campoDe(p, "26")).toContain("br.gov.bcb.pix");
    expect(campoDe(p, "26")).toContain("contato@clinica.com");
  });

  // O CRC fecha o payload e é calculado sobre TUDO que veio antes, incluindo o
  // próprio "6304". Errar isso é o erro clássico do BR Code.
  it("fecha com um CRC que confere", () => {
    const p = gerarCopiaECola(base);
    expect(p.slice(-8, -4)).toBe("6304");
    const semCrc = p.slice(0, -4);
    expect(p.slice(-4)).toBe(crc16(semCrc));
  });

  it("inclui o valor quando há sinal", () => {
    const p = gerarCopiaECola({ ...base, valorCentavos: 5000 });
    expect(campoDe(p, "54")).toBe("50.00");
  });

  // Sem valor, o paciente digita quanto vai pagar — é o caso de "traga o sinal".
  it("omite o valor quando não há", () => {
    expect(campoDe(gerarCopiaECola(base), "54")).toBe(null);
    expect(campoDe(gerarCopiaECola({ ...base, valorCentavos: 0 }), "54")).toBe(null);
  });

  it("usa *** quando não há identificador", () => {
    expect(campoDe(gerarCopiaECola(base), "62")).toBe("0503***");
  });

  it("leva o identificador quando há", () => {
    const p = gerarCopiaECola({ ...base, identificador: "CONSULTA123" });
    expect(campoDe(p, "62")).toBe("0511CONSULTA123");
  });

  it("aguenta nome e cidade vazios sem gerar campo inválido", () => {
    const p = gerarCopiaECola({ ...base, beneficiario: "", cidade: "" });
    expect(campoDe(p, "59")).toBe("RECEBEDOR");
    expect(campoDe(p, "60")).toBe("SAO PAULO");
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
  });

  // Todo campo TLV tem de declarar o próprio tamanho corretamente, senão o
  // leitor do banco se perde no meio do payload.
  it("todo campo declara o tamanho certo", () => {
    const p = gerarCopiaECola({ ...base, valorCentavos: 12345, identificador: "X1" });
    let i = 0;
    let campos = 0;
    while (i < p.length) {
      const len = Number(p.slice(i + 2, i + 4));
      expect(Number.isFinite(len), `tamanho ilegível na posição ${i}`).toBe(true);
      i += 4 + len;
      campos++;
    }
    expect(i).toBe(p.length); // fechou exatamente no fim
    expect(campos).toBeGreaterThan(5);
  });
});

describe("chavePixValida", () => {
  it("aceita chaves bem formadas", () => {
    expect(chavePixValida("123.456.789-09", "cpf")).toBe(true);
    expect(chavePixValida("12.345.678/0001-95", "cnpj")).toBe(true);
    expect(chavePixValida("contato@clinica.com.br", "email")).toBe(true);
    expect(chavePixValida("(51) 99999-8888", "telefone")).toBe(true);
    expect(chavePixValida("123e4567-e89b-12d3-a456-426614174000", "aleatoria")).toBe(true);
  });

  it("recusa o que o banco recusaria", () => {
    expect(chavePixValida("", "cpf")).toBe(false);
    expect(chavePixValida("123", "cpf")).toBe(false);
    expect(chavePixValida("sem-arroba", "email")).toBe(false);
    expect(chavePixValida("999", "telefone")).toBe(false);
    expect(chavePixValida("nao-e-uuid", "aleatoria")).toBe(false);
  });
});
