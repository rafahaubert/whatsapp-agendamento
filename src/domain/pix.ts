/**
 * Pix copia-e-cola (BR Code).
 *
 * O sinal é o único remédio de verdade contra falta: quem pagou aparece. Mas
 * pedir "faça um Pix para a chave tal" no WhatsApp gera erro de digitação e
 * paciente perdido. O copia-e-cola resolve — o paciente cola no banco e o valor,
 * o beneficiário e a identificação já vêm preenchidos.
 *
 * O formato é o EMV® QR Code (BR Code) do Banco Central: campos TLV
 * (tag + tamanho em 2 dígitos + valor), fechados por um CRC16. É totalmente
 * determinístico, então mora aqui como regra pura — sem rede, sem gateway,
 * sem dependência nova.
 *
 * O que isto NÃO faz: confirmar o pagamento. A baixa é manual na recepção. Uma
 * integração com gateway (Mercado Pago, Asaas) automatizaria a confirmação; é
 * uma decisão de fornecedor, não um detalhe de implementação.
 */

/** Tipos de chave Pix aceitos. */
export type TipoChavePix = "cpf" | "cnpj" | "email" | "telefone" | "aleatoria";

export interface DadosPix {
  /** A chave, como cadastrada no banco. */
  chave: string;
  tipo: TipoChavePix;
  /** Nome do beneficiário (vai truncado em 25 caracteres, sem acento). */
  beneficiario: string;
  /** Cidade do beneficiário (truncada em 15). */
  cidade: string;
  /** Valor em centavos. Omitido = o paciente digita o valor. */
  valorCentavos?: number;
  /** Identificação da cobrança (txid). Sem ela vai "***". */
  identificador?: string;
}

/**
 * CRC16-CCITT-FALSE: polinômio 0x1021, inicial 0xFFFF, sem reflexão e sem XOR
 * final. É o que o BR Code exige — trocar por outra variante de CRC16 gera um
 * código que o banco recusa sem dizer por quê.
 */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Um campo TLV: tag + tamanho em dois dígitos + valor. */
function campo(tag: string, valor: string): string {
  return `${tag}${String(valor.length).padStart(2, "0")}${valor}`;
}

/**
 * Texto aceito nos campos de nome e cidade: sem acento, maiúsculo, só o que o
 * padrão prevê. Acento passa pelo gerador e quebra na leitura de alguns bancos.
 */
export function normalizarTexto(s: string, max: number): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .toUpperCase()
    .slice(0, max);
}

/**
 * A chave como ela entra no BR Code.
 *
 * Telefone vai em E.164 (+55...) e CPF/CNPJ só com dígitos — é assim que o
 * arranjo espera. E-mail e chave aleatória vão como estão, minúsculos.
 */
export function normalizarChave(chave: string, tipo: TipoChavePix): string {
  const bruta = chave.trim();
  if (tipo === "cpf" || tipo === "cnpj") return bruta.replace(/\D/g, "");
  if (tipo === "telefone") {
    const digitos = bruta.replace(/\D/g, "");
    // Um número brasileiro sem o código do país é o erro mais comum aqui.
    return digitos.startsWith("55") ? `+${digitos}` : `+55${digitos}`;
  }
  return bruta.toLowerCase();
}

/** Valor em centavos → o formato do campo 54 ("150.00", ponto decimal). */
export function formatarValor(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * Monta o copia-e-cola.
 *
 * A ordem dos campos importa: o CRC no fim é calculado sobre tudo que veio
 * antes, incluindo o próprio "6304".
 */
export function gerarCopiaECola(dados: DadosPix): string {
  const chave = normalizarChave(dados.chave, dados.tipo);

  // 26 — informação da conta do recebedor, aninhada.
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", chave);

  // 62 — dados adicionais. O txid vai em "05"; "***" quando não há um.
  const txid = normalizarTexto(dados.identificador ?? "", 25) || "***";
  const adicionais = campo("05", txid);

  let payload =
    campo("00", "01") + // formato do payload
    campo("26", conta) +
    campo("52", "0000") + // categoria do estabelecimento (não usada)
    campo("53", "986"); // moeda: real

  // Valor é opcional: sem ele, o paciente digita quanto vai pagar.
  if (dados.valorCentavos && dados.valorCentavos > 0) {
    payload += campo("54", formatarValor(dados.valorCentavos));
  }

  payload +=
    campo("58", "BR") +
    campo("59", normalizarTexto(dados.beneficiario, 25) || "RECEBEDOR") +
    campo("60", normalizarTexto(dados.cidade, 15) || "SAO PAULO") +
    campo("62", adicionais);

  // O CRC cobre o payload MAIS o cabeçalho do próprio campo ("6304").
  const comCabecalhoDoCrc = `${payload}6304`;
  return `${comCabecalhoDoCrc}${crc16(comCabecalhoDoCrc)}`;
}

/**
 * A chave parece válida para o tipo declarado?
 *
 * Validação de formato, não de existência — só o banco sabe se a chave existe.
 * Serve para o painel avisar na hora em vez de o paciente descobrir com um
 * copia-e-cola que o banco recusa.
 */
export function chavePixValida(chave: string, tipo: TipoChavePix): boolean {
  const v = chave.trim();
  if (!v) return false;

  switch (tipo) {
    case "cpf":
      return /^\d{11}$/.test(v.replace(/\D/g, ""));
    case "cnpj":
      return /^\d{14}$/.test(v.replace(/\D/g, ""));
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 77;
    case "telefone": {
      const d = v.replace(/\D/g, "");
      // 10 ou 11 dígitos (com DDD), ou 12/13 já com o código do país.
      return /^\d{10,11}$/.test(d) || /^55\d{10,11}$/.test(d);
    }
    case "aleatoria":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }
}
