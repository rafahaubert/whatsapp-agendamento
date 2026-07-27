/**
 * Proposta comercial servida em domínio próprio (`/proposta`).
 *
 * O arquivo `marketing/proposta-clinicas.html` é um FRAGMENTO: não tem
 * `<!doctype>`, `<html>` nem `<head>`, porque o publicador de artifacts injeta
 * esse esqueleto. Servido cru, o navegador cairia em modo quirks e — sem a meta
 * viewport — o material abriria reduzido no celular, que é onde a clínica lê.
 * Por isso envolvemos o fragmento aqui, em vez de duplicar o arquivo.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CAMINHO_PROPOSTA = path.join("marketing", "proposta-clinicas.html");

/** Mesmo esqueleto (e reset) que o publicador de artifacts aplica. */
export function envolverEmPagina(fragmento: string): string {
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<style>*{margin:0;padding:0}img,svg{display:block;max-width:100%}</style>" +
    `</head><body>${fragmento}</body></html>`
  );
}

/** Lido uma vez por processo — o arquivo não muda entre requisições. */
let cache: string | null = null;

export async function carregarProposta(): Promise<string> {
  if (cache === null) {
    const arquivo = path.resolve(process.cwd(), CAMINHO_PROPOSTA);
    cache = envolverEmPagina(await readFile(arquivo, "utf8"));
  }
  return cache;
}
