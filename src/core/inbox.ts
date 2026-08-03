/**
 * Caixa de entrada: agrupa mensagens e serializa o processamento por conversa.
 *
 * Dois problemas reais, um módulo:
 *
 * 1. O paciente manda "teria que ser mais tarde" e, dois segundos depois,
 *    "me manda outras opções". Cada uma chega num POST separado da Meta e
 *    virava uma resposta separada — o bot respondia enquanto ele ainda
 *    digitava. Aqui elas viram UM lote.
 *
 * 2. Pior que a resposta dobrada: as duas execuções rodavam em PARALELO, cada
 *    uma lendo o mesmo histórico e gravando por cima da outra. Foi assim que o
 *    agente agendou enquanto o paciente ainda perguntava o preço. A fila por
 *    conversa garante uma execução por vez.
 *
 * Estado em memória: vale para uma instância (é como o serviço roda hoje —
 * `min_machines_running = 1` no fly.toml, uma instância no plano free do
 * Render). Se o processo reiniciar dentro da janela de espera, o lote pendente
 * se perde.
 */
import type { IncomingMessage } from "../channels/types.js";

type Processador = (mensagens: IncomingMessage[]) => Promise<void>;

interface Pendente {
  mensagens: IncomingMessage[];
  timer: ReturnType<typeof setTimeout>;
  processar: Processador;
}

const pendentes = new Map<string, Pendente>();
const filas = new Map<string, Promise<void>>();

/** Chave de agrupamento: uma conversa é (clínica, telefone). */
export function chaveConversa(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

/**
 * Executa `fn` em série dentro de uma mesma chave: nada começa antes de o
 * anterior terminar. Falhas não travam a fila.
 */
export function enfileirar(chave: string, fn: () => Promise<void>): Promise<void> {
  const anterior = filas.get(chave) ?? Promise.resolve();
  const atual = anterior.then(fn);
  const registrada = atual.catch(() => {});
  filas.set(chave, registrada);
  void registrada.then(() => {
    if (filas.get(chave) === registrada) filas.delete(chave);
  });
  return atual;
}

/**
 * Guarda a mensagem e dispara `processar` com o lote quando passarem
 * `esperaMs` sem nada novo na mesma conversa.
 *
 * Clique em opção (`payload`) não espera: o paciente já decidiu.
 */
export function agruparMensagem(
  chave: string,
  mensagem: IncomingMessage,
  esperaMs: number,
  processar: Processador,
): void {
  const anterior = pendentes.get(chave);
  if (anterior) clearTimeout(anterior.timer);

  const mensagens = anterior ? [...anterior.mensagens, mensagem] : [mensagem];
  const espera = mensagem.payload ? 0 : Math.max(0, esperaMs);

  const timer = setTimeout(() => {
    pendentes.delete(chave);
    void enfileirar(chave, () => processar(mensagens));
  }, espera);

  pendentes.set(chave, { mensagens, timer, processar });
}

/** Só para testes: descarta lotes pendentes e filas. */
export function limparCaixaDeEntrada(): void {
  for (const p of pendentes.values()) clearTimeout(p.timer);
  pendentes.clear();
  filas.clear();
}

/** Quantos lotes estão esperando a janela de agrupamento fechar. */
export function pendentesAgora(): number {
  return pendentes.size;
}

/**
 * Fecha a caixa de entrada: processa AGORA tudo que está esperando e aguarda o
 * que já está em execução.
 *
 * Sem isto, todo deploy jogava fora as mensagens dentro da janela de debounce
 * (oito segundos, por padrão). O paciente escrevia, o processo morria e a Meta
 * não reenvia — o webhook responde 200 antes de processar. Para ele, o bot
 * simplesmente ficou mudo.
 *
 * Não é uma garantia absoluta: o que a Meta entregou e ainda não virou lote
 * continua se perdendo, e o estado é de memória. Mas cobre a janela em que a
 * perda era CERTA a cada reinício.
 */
export async function drenarCaixaDeEntrada(): Promise<number> {
  const agora = [...pendentes.entries()];
  pendentes.clear();

  for (const [chave, p] of agora) {
    clearTimeout(p.timer);
    void enfileirar(chave, () => p.processar(p.mensagens));
  }

  // As filas por conversa são reentrantes: enfileirar acima criou promessas
  // novas, então esperar a leva atual basta para cobrir o que foi drenado.
  await Promise.allSettled([...filas.values()]);
  return agora.length;
}
