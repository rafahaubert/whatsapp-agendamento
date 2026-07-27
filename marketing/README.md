# Material de vendas — clínicas

| Arquivo | O que é |
|---|---|
| [`proposta-clinicas.html`](proposta-clinicas.html) | Página de uma só rolagem para mandar ao cliente: prints das conversas, calculadora de agenda ociosa, painel, perguntas e proposta. |
| [`mensagens-prospeccao.md`](mensagens-prospeccao.md) | Mensagens prontas de primeiro contato, follow-up e respostas a objeções. |

## Link para mandar ao cliente

O próprio servidor publica a proposta em **`/proposta`** (ex.: `https://SEU-APP.onrender.com/proposta`).
É o link que vale mandar: domínio seu, sem tela de acesso e sem a tarja de "conteúdo não
verificado" que a hospedagem de artifacts coloca em volta.

A rota lê este arquivo em tempo de execução e o envolve no `<!doctype>`/`<head>` que falta
(ver `src/marketing/proposta.ts`) — sem isso o navegador cairia em modo quirks e a página
abriria reduzida no celular. Editou o HTML? Basta um novo deploy; não há build separado.

A rota é pública: quem tiver a URL vê os valores. Se quiser discrição, troque o caminho em
`src/server.ts` por algo não óbvio.

## Valores e contato

Três planos, no bloco `.planos` do fechamento:

| Plano | Valor | Corte | Cota |
|---|---|---|---|
| Essencial | R$ 490/mês | 1 unidade, até 2 profissionais. Lembrete anti-falta. | 300 msgs/mês |
| Profissional | R$ 799/mês | Até 6 profissionais. Soma fila de espera, Google Agenda e métricas. | 1.000 msgs/mês |
| Clínica | Sob consulta | Multi-unidade, sem limite. Soma a reativação de pacientes. | sob medida |

**A cota cobre só o que a clínica inicia** — lembrete e aviso de vaga. Responder paciente é
gratuito e ilimitado na Meta, então não entra na conta. Excedente: R$ 0,10/mensagem.

Custo real por trás da cota (tarifas Meta Brasil): mensagem **utility** ≈ R$ 0,04 — 1.000
lembretes custam ~R$ 40. Já o convite de retorno é **marketing** ≈ R$ 0,34, quase 9× mais
caro, e por isso a reativação só entra no plano sob consulta (ver aviso no
[`WHATSAPP-TEMPLATES.md`](../WHATSAPP-TEMPLATES.md)).

Implantação **R$ 500** em qualquer plano. Contato **(51) 99767-0770** (o botão do rodapé abre
`wa.me/5551997670770`), agente de teste em "3 dias úteis".

O corte entre os planos é implementável: `reminders.enabled`, `waitlist.enabled` e
`recall.enabled` são toggles por clínica no painel — não é diferenciação de fachada.

Para trocar valores, procure por `[EDITE` no HTML.

## Identidade

Extraída dos vetores originais da marca: verde `#163029`, cinza `#C8C8C8`, verde médio
`#41695B`. Os logos (balão, wordmarks HAUBERT e AGENTS, monograma HA) estão embutidos como
`<symbol>` SVG no topo do arquivo — sem dependência de fonte ou de arquivo externo.

## Como a página se comporta

- Um arquivo só, sem CSS/JS/fonte externos: abre offline e pode ser hospedado em qualquer lugar.
- Tema claro e escuro conforme o aparelho de quem abre.
- A conversa do topo se digita sozinha ao carregar; quem tem "reduzir movimento" ligado vê tudo parado.
- A calculadora usa os números que o próprio cliente digitar — não há projeção inventada.

## Honestidade do material

As conversas são **demonstrações** do fluxo real do agente, com clínica e pacientes
fictícios, e isso está dito no rodapé. Os números do painel são ilustrativos. Não há
estatística de resultado inventada em lugar nenhum — se for incluir caso real, peça
autorização da clínica antes.

## PDF

`proposta-clinicas.pdf` é a mesma página impressa em A4 (11 páginas), para quem prefere
anexo a link. Para regerar depois de editar o HTML, imprima a página pelo navegador em A4,
com "gráficos de plano de fundo" ligado e escala 78% — o `@media print` do arquivo já cuida
do resto (abre a conversa do topo inteira, abre o FAQ, encaixa a agenda na folha e fecha
numa última página inteira).
