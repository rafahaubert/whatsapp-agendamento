/**
 * Regras de permissão do painel — funções puras, sem Express, banco nem
 * ambiente. Ficam separadas justamente para poderem ser testadas: é aqui que
 * mora a decisão, e é a decisão que precisa de prova.
 */
import { Role } from "../shared/enums.js";

/**
 * Quem pode mexer num usuário DENTRO da tela de uma clínica.
 *
 * A tela de usuários passou a existir dentro da clínica, então o admin da
 * clínica gerencia a própria recepção. Isso abre três caminhos de escalada que
 * `requireTenant` não fecha — ele confere o :id da URL, não o alvo da ação:
 *
 *  1. mandar o id de um usuário de OUTRA clínica no corpo do POST;
 *  2. mexer num SUPER que apareça na listagem;
 *  3. desativar ou excluir a si mesmo, e trancar a clínica para fora.
 */
export function podeGerenciarUsuarioDaClinica(
  ator: { userId?: string; role?: string },
  clinicaId: string,
  alvo: { id: string; role: string; tenantId: string | null },
): { ok: true } | { ok: false; motivo: string } {
  if (alvo.role === Role.SUPER) {
    return { ok: false, motivo: "Usuários da plataforma não são gerenciados pela clínica." };
  }
  if (alvo.tenantId !== clinicaId) {
    return { ok: false, motivo: "Este usuário não pertence a esta clínica." };
  }
  // Vale inclusive para o SUPER: perder o próprio acesso é sempre acidente.
  if (ator.userId && ator.userId === alvo.id) {
    return { ok: false, motivo: "Você não pode remover ou desativar o seu próprio acesso." };
  }
  return { ok: true };
}
