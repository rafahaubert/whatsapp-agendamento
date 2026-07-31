/**
 * Converte para string um valor vindo de fora (query string, corpo de
 * formulário, webhook).
 *
 * `String(v)` não serve aqui. O Express interpreta colchetes na query: `?q=oi`
 * chega como `"oi"`, mas `?q[]=a&q[]=b` chega como array e `?q[x]=1` como
 * objeto — e `String({})` vira `"[object Object]"`, que segue adiante como se
 * fosse busca legítima. Não é falha de segurança (tudo é escapado nas views e
 * parametrizado no Prisma), mas é entrada malformada virando dado.
 *
 * Array devolve o primeiro elemento, que é o que o usuário quis dizer quando o
 * campo aparece repetido. Objeto e demais tipos devolvem "".
 */
export function texto(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (valor == null) return "";
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  if (Array.isArray(valor)) return valor.length ? texto(valor[0]) : "";
  return "";
}

/** `texto()` já aparado nas pontas — o formato mais usado em formulário. */
export function textoAparado(valor: unknown): string {
  return texto(valor).trim();
}
