/**
 * Casar o nome que o paciente diz ("Josué", "josue santana") com um cadastro
 * que já existe naquele telefone.
 *
 * Existe porque quem já é da casa não deve ter de repetir nome completo e CPF
 * a cada conversa: o número já foi provado pelo WhatsApp e identifica o
 * cadastro; o nome só desempata quando o telefone é da família.
 */

/** Sem acento, sem pontuação, minúsculo — "José Antônio" e "jose antonio" são o mesmo. */
export function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * O único cadastro compatível com `nome`, ou `undefined`.
 *
 * Deliberadamente conservador: na dúvida (dois "Ana" no mesmo telefone, nome
 * que não bate com ninguém) devolve `undefined` e quem chamou pede o CPF.
 * Uma pergunta a mais custa uma mensagem; marcar na ficha da pessoa errada
 * custa o atendimento inteiro.
 */
export function casarNome<T extends { name: string }>(
  cadastrados: T[],
  nome: string,
): T | undefined {
  const alvo = normalizarNome(nome);
  if (!alvo) return undefined;

  const exatos = cadastrados.filter((c) => normalizarNome(c.name) === alvo);
  if (exatos.length) return exatos.length === 1 ? exatos[0] : undefined;

  // "Josué" para o cadastro "Josué Santana" — e o contrário, quando ele diz o
  // nome completo e o cadastro guarda só o primeiro.
  const parciais = cadastrados.filter((c) => {
    const n = normalizarNome(c.name);
    return n.startsWith(`${alvo} `) || alvo.startsWith(`${n} `);
  });
  return parciais.length === 1 ? parciais[0] : undefined;
}
