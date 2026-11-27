# Módulo Indicadores do Hub — diagnóstico e proposta (27/11/2026)

Rascunho para decisão do André. Nada aqui está implementado. Baseado em: `indicadores.html`, `api/_indicadores.js`, memória do projeto,
`bav-boxer/docs/arquitetura-base-cliente.md`, o módulo **M3 Clientes** do BAV (`template.html`, `gerar_html_estatico.py`) e dados reais do Hub.

## 1. O que existe hoje no Hub

| Parte | O que mostra | Limitação |
|---|---|---|
| Por revenda (`indicadores.html`) | KPIs: orçamentos gerados, pedidos confirmados, faturamento, conversão, ticket médio, títulos vencidos; últimos orçamentos/pedidos; **produtos mais pedidos**; funil por mês | Uma loja por vez (agora existe a entidade grupo/empresa); sem comparação de período; sem Mix; sem status de cliente |
| Visão geral (staff) | Funil mensal (orçamentos → pedidos → faturado → pendente), 13 meses | Só funil; sem cliente, vendedor, produto, canal, região |
| Fonte | `hub_pedidos` (só `tipo_operacao='venda'`), `orcamentos`, `hub_notas_fiscais`, `hub_titulos` | Teto de 3.000 linhas por consulta; "faturamento" = valor da NF (não líquido de devolução) |

Já pensado e registrado (memória/docs): funil de orçamento→pedido→faturado (feito 16/11); indicadores por cliente "pra todos os tipos de usuário";
**tempo por etapa do pedido** e **vendas agrupadas (MERGED)** (propostos em 26/11, ainda não feitos); `hub_v_solicitacoes_indicadores` (canal de resolução);
objetivos de negócio em `docs/01-fundacao/02-objetivos-de-negocio.md` (autonomia da revenda, ciclo de pedido <5 min, aprovação <2 h, transparência).
**Nunca foi feita** a visão de cliente item a item / Mix.

## 2. O que o BAV (M3 Clientes) tem e é referência

- **Status do cliente** por regra simples: Novo (1ª compra ≤365 d), Ativo (última compra ≤180 d), **Quase inativo** (181–365 d), Inativo (>365 d), Reativado
  (voltou depois de longo gap). Painel "Quase Inativos: compraram em 2025 e não em 2026".
- **Curva ABC** (A até 80% do faturamento, B até 95%, C resto), recalculada sobre o conjunto filtrado.
- **Cockpit do Cliente** (por *entidade* = grupo→raiz→loja): cabeçalho com vendedor real (quem mais vendeu), segmento, UF, nº de filiais, última compra, variação;
  **7 KPIs**; evolução mensal de 3 anos; **Mix por categoria**; **Top produtos**; **Maiores quedas / ausentes** (o que comprava e parou);
  **Indicadores comerciais**; **Sugestão de recompra**; **Oportunidades de cross-sell** (categorias que clientes parecidos compram e ele não).
- **Churn/saúde por vendedor** (ativos, quase inativos, inativos, novos, reativados por carteira), ranking de vendedores, pedidos abertos cruzados por produto.
- Dados: histórico completo desde 2018 (R$ 460M) + ZEN (NF de saída, devolução como negativo, perfis fiscais por tag).

## 3. Lacuna de dados (o ponto que decide o escopo)

| Dado | Hub hoje | BAV | Consequência |
|---|---|---|---|
| Pedidos | 6.114 vendas desde **05/01/2026** (itens em 5.610; 777 sem itens) | 2018 → hoje | Hub não tem 12–36 meses de histórico por item |
| Notas fiscais | 18.194 desde 28/02/2025, **sem itens** | NF item a item | Sem Mix histórico a partir da NF |
| Devolução | Não entra | Entra (negativa) | Faturamento do Hub é bruto |
| Perfil fiscal | `tipo_operacao` (texto) | Tag `revenue`/`return`/`no-value` | Migrar para as tags do ZEN |
| Entidade | `entidade_key` (igual ao BAV) | `entidade_key` | Compatível |

Para "item a item por cliente em 12–36 meses" existem três caminhos: **(A)** trazer do ZEN os itens de NF de saída (`fiscal/outgoingInvoiceItem`) desde 03/2025 para
uma tabela do Hub (a regra de 01/03/2025 já existe); **(B)** levar do BAV agregados por entidade×produto×mês para o Supabase (histórico longo, atualizado no CI do BAV);
**(C)** abrir o BAV a partir do Hub (link). Recomendação: **A para o dia a dia (vivo, mesma fonte do pedido) + B só se quiserem comparar com 2018–2024.**

## 4. Boas práticas de indicadores comerciais B2B (para a definição)

1. **Hierarquia de leitura**: Empresa → Carteira/vendedor → Cliente(entidade) → Item. Cada nível responde uma pergunta diferente (decisão ≠ monitoramento).
2. **Poucos KPIs por tela, sempre com comparação** (vs mês anterior, vs mesmo mês do ano anterior, vs meta quando houver) e **semáforo**.
3. **Crescimento da base**: Receita líquida (NF − devolução), nº de clientes ativos, **Novos/Reativados/Perdidos**, taxa de retenção e **churn**, retenção de receita (NRR).
4. **Profundidade do cliente (o foco do André)**: **penetração de Mix** = SKUs/categorias do Mix-alvo que o cliente compra ÷ total do Mix-alvo; **white space**
   (o que compra, o que falta); **share of wallet** estimada; **frequência e recência**; **ticket médio e itens por pedido**.
5. **Segmentação**: ABC (valor), **RFM** (recência, frequência, valor) e **ABC×XYZ** de produto (valor × previsibilidade).
6. **Pipeline e conversão**: funil orçamento→pedido→faturado, taxa de conversão, **tempo por etapa** (onde o pedido trava), idade do orçamento aberto, valor em aberto.
7. **Operação e crédito**: OTIF/atraso de faturamento, backorder, **aging de títulos**, DSO, % do limite usado, bloqueios.
8. **Qualidade do dado e governança**: uma definição por KPI (documentada), fonte única (ZEN), recorte por entidade, e dado "vivo" (carimbo de atualização na tela).

## 5. Proposta de estrutura

**Nível 1 — Visão geral Boxer (staff)**: receita líquida e vs ano anterior; clientes ativos/novos/reativados/perdidos; funil; tempo por etapa; backlog; aging; top vendas por canal/UF/categoria.
**Nível 2 — Carteira (representante, e staff por vendedor)**: saúde da carteira (Ativo/Quase inativo/Inativo/Novo/Reativado), ABC, clientes a visitar (quase inativos, queda), meta de Mix.
**Nível 3 — Cockpit do Cliente (entidade)**: igual ao M3 — KPIs, evolução, **Mix (comprado × não comprado)**, quedas/ausentes, sugestão de recompra, cross-sell, títulos, pedidos/orçamentos abertos,
com o seletor **"só esta loja / o grupo todo"** (etapa 4 de grupo). Para a revenda, uma versão enxuta do próprio Mix ("o que você ainda não compra").

### KPIs candidatos do Cockpit (7)
Receita 12m (e vs 12m anterior) · Pedidos 12m · Ticket médio · Itens por pedido · **Penetração de Mix (%)** · Última compra / dias sem comprar · Conversão de orçamentos.

## 6. Decisões necessárias (André)
1. **Dados históricos:** caminho A (ZEN→Hub desde 03/2025), B (BAV→Hub) ou ambos?
2. **Mix-alvo:** como definir "o Mix possível" — por **segmento/canal do cliente** (Varejo, Híbrido, Ecommerce), por **categorias obrigatórias**, ou por lista que o comercial mantém?
3. **Status/ABC:** adotar as regras do BAV (180/365 dias; 80/95%) ou ajustar?
4. **Receita:** passar a líquida (NF − devolução, só tag `revenue`)?
5. **Quem vê o quê:** revenda vê só o próprio Mix? Representante a carteira (inclui grupo)? Staff tudo?
6. **Prioridade:** começo pelo Cockpit do Cliente (nível 3) e depois carteira/visão geral?
