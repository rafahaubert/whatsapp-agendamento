/**
 * Mascaramento de dados pessoais para log.
 *
 * A alternativa seria só apagar o campo, mas aí o log perde o que o torna útil:
 * correlacionar as linhas de uma mesma conversa. Guardar o fim do telefone
 * resolve os dois lados — dá para seguir um atendimento sem registrar o número
 * inteiro de um paciente em Datadog/Loki.
 */

/**
 * `+5551999887766` → `+55519****7766`. Preserva DDI/DDD e os 4 últimos dígitos.
 * Entradas curtas ou vazias viram um marcador, nunca o valor cru.
 */
export function mascararTelefone(telefone: string | null | undefined): string {
  if (!telefone) return "(sem telefone)";
  const t = telefone.trim();
  if (t.length <= 8) return "***";
  return `${t.slice(0, 5)}****${t.slice(-4)}`;
}

/**
 * Mascara o identificador submetido no login. Existe porque o campo é livre: se
 * alguém digitar a senha no lugar do usuário, ela ia inteira para o log em texto
 * plano. Preserva o suficiente para investigar um ataque (prefixo + domínio).
 *
 * `rafael@gmail.com` → `raf***@gmail.com` · `minhaSenha123` → `min***`
 */
export function mascararIdentificador(id: string | null | undefined): string {
  if (!id) return "(vazio)";
  const v = id.trim();
  const arroba = v.indexOf("@");
  if (arroba > 0) return `${v.slice(0, Math.min(3, arroba))}***${v.slice(arroba)}`;
  return `${v.slice(0, 3)}***`;
}
