# Material de vendas — clínicas

| Arquivo | O que é |
|---|---|
| [`proposta-clinicas.html`](proposta-clinicas.html) | Página de uma só rolagem para mandar ao cliente: prints das conversas, calculadora de agenda ociosa, painel, perguntas e proposta. |
| [`mensagens-prospeccao.md`](mensagens-prospeccao.md) | Mensagens prontas de primeiro contato, follow-up e respostas a objeções. |

## Antes de enviar

Abra o HTML e preencha os pontos marcados com `[EDITE`:

| Marca | O que trocar |
|---|---|
| `[EDITE: CONTATO]` | Link `wa.me` e telefone no rodapé |
| `[EDITE: PREÇO]` | Implantação e mensalidade (hoje `R$ 0.000` / `R$ 000`) |
| `[EDITE: PRAZO]` | Prazo do agente de teste (hoje "3 dias úteis") |

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
