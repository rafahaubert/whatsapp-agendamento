/** Remove tudo que não é dígito. */
export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Validação de CPF com dígitos verificadores (algoritmo oficial). */
export function isValidCpf(raw: string): boolean {
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // rejeita 000..., 111..., etc.

  const digito = (base: string, fatorInicial: number): number => {
    let soma = 0;
    let fator = fatorInicial;
    for (const ch of base) soma += Number(ch) * fator--;
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const d1 = digito(cpf.slice(0, 9), 10);
  const d2 = digito(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}
