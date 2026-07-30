import crypto from "node:crypto";

/**
 * Compara duas strings em tempo constante. Usar sempre que os dois lados forem
 * segredos (senha, token, assinatura): `===` sai mais cedo no primeiro byte
 * diferente, o que vaza o prefixo correto por tempo de resposta.
 *
 * A checagem de tamanho vem antes porque `timingSafeEqual` lança se os buffers
 * tiverem comprimentos diferentes. Isso vaza o COMPRIMENTO do segredo, o que é
 * aceitável — o conteúdo continua protegido.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
