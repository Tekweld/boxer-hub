# Integração Zen ↔ Hub Comercial — plano e perguntas em aberto

Recorte do que o Hub precisa da API Zen. Referência completa da API em
`referencia-api-zen.md`.

> ## ⚠ ATUALIZADO EM 2026-09-02 — LEIA ANTES DO RESTO
>
> **Este documento foi escrito em 2026-08-27, quando não havia integração
> nenhuma. Boa parte dele já foi implementada — e a implementação, não este
> texto, é a regra.**
>
> Um agente leu a seção de estoque abaixo como se fosse o estado atual e
> reportou como "divergência" uma decisão que já tinha sido superada pelo
> código. Para não repetir:
>
> **Regra geral: quando este documento e o código divergirem, o código vence.**
> Antes de reportar divergência, compare as datas — doc anterior ao código quase
> sempre significa doc velha, não código errado.
>
> Já implementado e validado em produção (não é mais "em aberto"):
>
> | Assunto | Onde vive a verdade |
> |---|---|
> | Autenticação, paginação, RSQL | `api/_zen.js` |
> | **Estoque** | `api/sync-estoque.js` — **ver seção 1, reescrita** |
> | Clientes / representantes | `api/sync-zen-clientes.js` |
> | Limite de crédito | `api/sync-zen-clientes.js` + `api/convite.js` |
> | **Pedido → Zen** | `api/push-pedido.js` — cria `sale.Sale` (validado com venda real) |
> | Nós de workflow, saleProfile | confirmados na API real — ver seção 3 |
>
> Estado do projeto e fila de próximos passos vivem na **memória do Claude
> Code** (ver seção "MEMÓRIA DO PROJETO" no `CLAUDE.md` da raiz), não aqui.

| Tabela SYNC | Linhas hoje | Origem Zen |
|---|---|---|
| `hub_clientes` | 2 | `catalog.person.Person` |
| `hub_representantes` | 0 | `catalog.person.Person` (`personSalesperson`) |
| `hub_titulos` | 0 | `financial.Receivable` |
| `hub_notas_fiscais` | 0 | `fiscal.OutgoingInvoice` |
| `hub_produtos.estoque_disponivel` | 0 em 560 | `material.Stock` / `StockAvailability` |

---

## 1. Estoque — RESOLVIDO E EM PRODUÇÃO (seção reescrita em 2026-09-02)

**A regra é o código do Ayrton: `api/sync-estoque.js`.** Confirmado por André em
2026-09-02 — a visão de estoque real disponível está correta. Não trocar de
fonte, não adicionar filtro de cluster, não "corrigir" com base no plano antigo
que estava aqui.

### Como funciona de fato

Não usa `material.Stock` nem compõe saldo na mão. Usa o cubo de relatório:

```
POST /system/data/dataSourceOpRead
  { "code": "/salesbreath/stockAvailabilityCube",
    "parameters": { SHOW_PRODUCT: true, SHOW_PRODUCT_PACKING: true, SHOW_SCHEDULE: true } }
```

Soma `quantity_balance` por `product_code`, zera negativos, grava em
`hub_produtos.estoque_disponivel`. **`quantity_balance` já É o disponível para
venda** — o cubo entrega o líquido, incluindo o desconto de saída comprometida
(`quantity_outgoing`, coluna separada no mesmo cubo). Não é preciso descontar
reserva por fora.

Uma chamada devolve a base inteira (~3.000 linhas): o custo no Zen **não**
depende de quantos SKUs interessam, então filtrar produto não alivia nada.

**Agendamento:** de hora em hora, 24/7, por **GitHub Actions**
(`.github/workflows/sync-estoque.yml`) — não por Vercel Cron, porque o plano
Hobby só aceita cron diário. Grava só o que mudou (~95% dos produtos não mudam
entre rodadas).

**Cobertura real:** 586 de 691 SKUs ativos têm estoque. Os demais têm estoque
zero de verdade (os produtos existem no Zen, só não têm linha de estoque) — não
é erro de SKU.

**Complemento — previsão de chegada:** `api/disponibilidade.js` busca remessas
em trânsito num **Supabase separado** (projeto FUP), dado que o Zen não tem. O
estoque atual vem do Zen; o FUP entra **só** para a previsão.

### O que estava escrito aqui antes, e por que saiu

O plano de 2026-08-27 previa compor `Stock.quantity` com `status = FREE`,
filtrar `stockCluster ∈ (MAQ)` e descontar `Reservation`. Nada disso foi usado:
o cubo resolve tudo isso do lado do Zen. A decisão de restringir a máquinas
novas foi **superada** — o sync traz tudo, e a segmentação por perfil de produto,
se um dia for necessária, é decisão de exibição no catálogo, não do conector.
A previsão de que consumíveis ficariam sem informação também não se
concretizou: eles têm estoque normalmente.

### Ainda vale do plano original

| Questão | Decisão (mantida) |
|---|---|
| SKU | **Mesmo código entre as fontes** — `hub_produtos.sku` = `Product.code`, normalizado com `UPPER(TRIM())` |
| Unidade | **Sempre item unitário.** A Boxer não trabalha com caixa master |
| Previsão de chegada | Não vem do Zen — vem do FUP (`api/disponibilidade.js`) |

---

## 2. Webhook nativo muda a arquitetura

`system.automation.Watcher` (evento + URI) elimina a necessidade de polling.
O padrão passa a ser:

```
Zen (evento) → Watcher → /api/webhook-zen (Vercel) → Supabase
```

Em vez de um cron varrendo a API. Vale para estoque, títulos liquidados e
mudança de status de pedido.

**Lacuna:** a especificação não lista os valores válidos de `Watcher.event` —
é string livre. Confirmar com o fornecedor ou testar em sandbox antes de
desenhar em cima disso.

Enquanto não confirmado, o fallback é `system.automation.Schedule` (CRON) ou um
cron do lado da Vercel.

---

## 3. Pedido — quem é dono do quê

O Hub tem `hub_pedidos` com status próprio
(`rascunho → submetido → em_analise → aprovado → …`). O Zen tem `sale.Sale.status`
(enum técnico fixo) **e** um workflow customizado com as etapas de negócio
(Aguardando Limite, Aguardando Importação…).

São três máquinas de estado para a mesma coisa. **Sem uma decisão explícita de
qual é a fonte da verdade, elas vão divergir.**

Duas opções:

| | Hub como dono | Zen como dono |
|---|---|---|
| Pedido nasce | `hub_pedidos` | `sale.Quote` ou `sale.Sale` via `saleOpCreate` |
| Status | Hub decide, empurra para o Zen | Zen decide, Hub espelha via webhook |
| Risco | Divergir do ERP | Hub depende do Zen estar no ar |

**Decidido em 2026-08-27: Zen como dono a partir da submissão.** O Hub é dono do
rascunho e do carrinho; ao submeter, cria um `Quote`/`Sale` no Zen e passa a
espelhar o status. Evita reimplementar regra de crédito e workflow que já existem
no ERP.

> **ATUALIZADO 2026-09-02 — decisão mantida, detalhes confirmados na API real.**
>
> Implementado como **`sale.Sale`** (não `Quote`), em `api/push-pedido.js`,
> validado com venda real: pedido HUB-2026-00001 virou a venda **47662** no Zen.
> `company` = TEKSP (id **1009**). `saleProfile` = DEFAULT (id **1001**), que
> aponta para o workflow **"Venda padrão"** — confirmado como o correto.
> `SaleItem` exige o id do **productPacking**, não o do `Product`: resolver com
> `/catalog/product/product?q=code==<sku>` e depois
> `/catalog/product/productPacking?q=product.id==<id>`.
>
> **São dois níveis de status, e a distinção importa para a tela:**
> `sale.status` é o enum duro (`PREPARED`, `PICKING`, `APPROVED`) e fica em
> `PREPARED` durante todo o processo. Quem conta a história útil é o **nó atual
> do workflow**, lido em `/system/workflow/workpieceNode` com
> `workflowNode.description` — valores reais em uso: `Análise de Crédito`,
> `Aguardando limite`, `Aguardando importação`, `Pedido aprovado`,
> `Pedido reprovado`, `WEB Pronta entrega`, `Programado`.
>
> ⚠ **Armadilha:** `workpiece.id` **não** é o id da venda. Use
> `sale.workpiece.id`, e o vínculo de volta vem em `workpiece.source`, no
> formato `/sale/sale:<saleId>`. Implementação de referência já pronta em
> `Tekweld/bav-boxer` → `backend/app/zen_pedidos.py`. Não reinventar.
>
> A **timeline do cliente deve espelhar `workflowNode.description`**, não
> `sale.status`.

`sale.Quote` tem `quoteOpSubmit` e `quoteOpApprove` — a alternativa Quote nunca
chegou a ser testada, já que `Sale` funcionou.

Implicação prática: `hub_pedidos.status` deixa de ser decidido pelo Hub e passa a
ser campo espelhado. O único status que o Hub controla sozinho é `rascunho`.
`hub_pedidos` ganha uma referência ao id do Zen (`erp_pedido_id`).

---

## 4. Crédito e títulos

- `financial.credit.CreditLineItem.value` → `hub_clientes.limite_credito`
- `financial.Receivable` → `hub_titulos`; atraso =
  `dueDate < hoje AND status != SETTLED AND balance > 0`
- `financial/receivableOpSettle` é o gatilho de "título pago" — relevante para
  liberar crédito bloqueado

O Hub hoje tem `limite_credito` e `limite_disponivel` preenchidos manualmente.
Com o Zen integrado, viram campos espelhados — não editáveis no Hub.

---

## 5. Sobreposição com o Monitor de Pedidos — decidir antes de construir

O documento `referencia-api-zen.md` foi escrito para o **Monitor de Pedidos**,
outro projeto, que também trata de pedidos, crédito, estoque e workflow do Zen.

**Hub e Monitor tocam os mesmos módulos.** Antes de escrever o conector, definir:

- Existe um conector Zen compartilhado, ou cada projeto faz o seu?
- Se ambos registram `Watcher` para o mesmo evento, quem processa o quê?
- O Monitor decide aprovação de pedido; o Hub também tem
  `hub_pedidos.status = aprovado`. Quem manda?

Duplicar o conector é o caminho mais rápido no curto prazo e o mais caro depois.

> **RESOLVIDO por André em 2026-09-01.** A divisão é por etapa do pedido:
>
> - **Hub = portão + motor de política** *antes* da submissão. É onde vivem
>   preço, estoque, crédito e regra comercial — inteligência que **não existe no
>   Zen**, e por isso o Hub é insubstituível nessa etapa.
> - **Zen = dono do pedido** a partir da submissão.
> - **Monitor de Pedidos = a administração do pedido.** O ADM de Vendas trabalha
>   o pedido lá, não no Hub. Hub e Monitor **se integram via Zen**, não
>   diretamente.
>
> Consequência prática: **não construir tela de aprovação de pedido no
> `admin.html`** — seria duplicar o Monitor. Depois da submissão o Hub é só
> registro e espelho.
>
> O portão é **binário**: qualquer inconsistência de estoque ou financeira
> trava o pedido, e o cliente resolve pelo próprio Hub antes de reenviar. Não
> existe pedido pendurado esperando exceção.

---

## 5a. Autenticação REAL — o que a spec não conta

**A spec descreve `/auth/login`, mas não é o que funciona.** O padrão validado em
produção está em `Tekweld/bav-boxer` (`scripts/zen_importador.py`), que importa
vendas do Zen diariamente há meses:

```
POST /system/security/tokenOpRequest
  headers: { tenant: "boxer" }
  body:    { "email": ..., "password": ... }     ← email, não username
  → resposta em TEXTO PURO, o token entre aspas — não é JSON

Demais chamadas:
  Authorization: Bearer <token>
  tenant: boxer
```

Três diferenças em relação ao que a spec sugere, e cada uma quebraria o
conector: endpoint diferente, `email` em vez de `username`, e resposta em texto
em vez de `{accessToken}`.

**`tenant` = `boxer`** — confirmado em dois projetos independentes
(`bav-boxer` e `boxer-app/supabase/functions/sync-zenerp-stock`).

### Sintaxe do filtro `q` — é RSQL/FIQL

A spec declara só `type: string`. O uso real:

```
sale.invoice.date>=2026-08-01;sale.invoice.flow==OUT;(status==APPROVED,status==SHIPMENT)
```

| Operador | Significado |
|---|---|
| `;` | AND |
| `,` | OR |
| `==` / `!=` | igual / diferente |
| `>=` `<=` `>` `<` | comparação |
| `( )` | agrupamento |
| `a.b.c` | navegação por relação |

### ⚠ Bug de paginação conhecido na API Zen

Documentado no `zen_importador.py`, com defesa já implementada:

> *"queries com range de datas entram em loop infinito após o último item real"*

O contorno em produção é fatiar por dia **e** manter um conjunto de ids já
vistos, parando quando a página não traz nada novo. `api/_zen.js` implementa a
mesma proteção (anti-ciclo por id + teto de segurança). **Não remover** achando
que é excesso de zelo — é bug real do fornecedor.

---

## 5b. Contrato declarado na spec (para referência)

Spec pública: `https://api.zenerp.app.br/platform/openapi.json` (2,18 MB,
889 paths, 342 schemas). O Swagger UI aponta para ela via
`swagger-initializer.js`.

```
POST /auth/login
  header: tenant: <valor>          ← obrigatório, inclusive no login
  body:   { "username": "...", "password": "..." }
  → 200:  { "accessToken": "...", "refreshToken": "..." }

Demais chamadas:
  Authorization: Bearer <accessToken>
  tenant: <valor>
```

`securitySchemes`: `Auth` = http bearer JWT · `Tenant` = apiKey no header `tenant`.
Há `POST /auth/refresh` para renovar sem novo login.

**Paginação:** todo GET de listagem aceita `q`, `order`, `first`, `max`. Sem
`max` explícito o servidor provavelmente aplica um default — **paginar sempre**,
pelo mesmo motivo que segurou as fotos da BOM.

**Sintaxe de `q` é desconhecida.** A spec declara só `type: string`, sem
`description`. Precisa ser descoberta em teste — é o que decide se dá para
buscar cliente por CNPJ direto ou se será preciso varrer e filtrar localmente.

### Mapeamento `catalog.person.Person` → `hub_clientes`

| Zen | Hub | Observação |
|---|---|---|
| `id` | `erp_cliente_id` | hoje NULO nos 2 clientes |
| `documentNumber` (com `documentType = BR_CNPJ`) | `cnpj` | **chave de casamento** |
| `name` | `razao_social` | |
| `fantasyName` | `nome_fantasia` | |
| `document2Number` (`BR_INSCRICAO_ESTADUAL`) | `inscricao_estadual` | |
| `email`, `phone` | `email_principal`, `telefone` | |
| `zipcode`/`street`/`number`/`complement`/`district`/`city` | `hub_enderecos` | |
| `personSalesperson` | `representante_id` | **é outra `Person`** |
| `priceListRetail` | `tabela_preco_id` | |
| `category1`–`category5` | `segmento`, `canal`, `porte` | **confirmar antes de usar** |
| — | `limite_credito` | **não vem de Person** → `credit.CreditLineItem` |

`personSalesperson` ser do tipo `Person` significa que **cliente e representante
saem da mesma entidade** — um único conector popula `hub_clientes` e
`hub_representantes`, e `hub_carteira` sai da própria referência.

`catalog.person.PersonCompact` (`id`, `type`, `name`, `fantasyName`,
`documentType`, `documentNumber`, `tags`) é a versão leve — suficiente para o
casamento inicial por CNPJ, sem trafegar o registro completo.

### Duas armadilhas já identificadas

**1. `Person` não tem campo de "ativo"** — nenhum schema de person na spec tem
`active`, `status`, `enabled` ou `blocked`. O critério é de negócio, e foi
definido em 2026-08-27:

> **Quem importar:** pessoas dos canais de venda **Híbrido, Ecommerce e Varejo**,
> cadastradas no Zen, **independente da data**.
>
> **Qual status dar:** com compra nos **últimos 12 meses** → `ativo`.
> Os demais entram como **suspensos** — ficam no Hub, mas não compram.

Duas consequências de arquitetura:

- O canal de venda precisa ser localizado em `Person`. Candidatos: `category1`–
  `category5`, `personGroup` ou `tags` — **a descobrir, não presumir**. É o que
  `api/zen-explorar.js` responde.
- "Compra nos últimos 12 meses" não está em `Person`: exige cruzar com
  `sale.Sale` ou `financial.Receivable` por pessoa. É uma segunda consulta, e
  define `hub_clientes.status_cadastro`.

Suspenso não é o mesmo que inativo: o cliente existe, aparece, mas não fecha
pedido. O RLS precisa refletir isso — hoje `status_cadastro` não é checado em
lugar nenhum.

**2. Formato de CNPJ inconsistente já no Hub:**

```
00.000.000/0001-00     ← com máscara
11222333000181         ← sem máscara
```

O CNPJ é a chave de casamento com `documentNumber`. É o mesmo problema do
`'99032 '` que quebrou o `on_conflict` do catálogo — e desta vez dá para
resolver antes. Normalizar para só dígitos, dos dois lados, com `CHECK`
constraint em `hub_clientes.cnpj`.

O formato usado pelo Zen em `documentNumber` também precisa ser verificado —
não presumir que é só dígitos.

---

## 6. Ordem sugerida

1. **Autenticar** — `POST /auth/login`, descobrir o header `Tenant` correto
2. **Explorar** — `GET /material/stockCluster`, `GET /system/workflow/workflow`,
   `GET /system/workflow/workflowNode` no ambiente real, e registrar o que
   existe de fato
3. **Estoque** (menor esforço, destrava o pedido) — conector
   `StockAvailability` → `hub_produtos.estoque_disponivel` + `previsao_chegada`
4. **Clientes e representantes** — `Person` → `hub_clientes`,
   `hub_representantes`, `hub_carteira`
5. **Pedido** — decidir dono (seção 3), então implementar
6. **Títulos e notas** — tela financeira

---

## 7. A confirmar no ambiente real

Nada abaixo deve ser presumido a partir do nome do endpoint ou do schema:

**Bloqueava o conector de cliente — TUDO RESOLVIDO, o conector está em produção:**
- [x] Credenciais e header `tenant` (= `boxer`) — ver 5a
- [x] Sintaxe do `q` — é RSQL, ver 5a
- [x] Formato de `documentNumber` — normalizado com `normDoc()` dos dois lados
- [x] Critério de "cliente ativo" — tag `blocked` no Zen entra como `suspenso`
- [x] `category1` — é onde vive o canal (Varejo / Híbrido / Ecommerce)

**Depois — resolvido em 2026-09-01/02:**
- [x] Nós de workflow cadastrados — listados na seção 3
- [ ] Valores aceitos por `Watcher.event` — **ainda em aberto.** Vale testar
      antes de construir sync de status por cron: o webhook nativo eliminaria o
      polling
- [ ] Se há ambiente de sandbox ou só produção — na prática, só produção

**Estoque e previsão — RESOLVIDO, ver seção 1 reescrita:**
- [x] Reserva: o cubo já entrega o líquido, não é preciso descontar por fora
- [x] Cluster `MAQ`: decisão superada — o cubo é a fonte, sem filtro de cluster
- [x] Previsão de chegada: vem do FUP (`api/disponibilidade.js`), não do Zen

**Aberto de verdade hoje:**
- [ ] **Endereços não são sincronizados.** `hub_enderecos` está vazia para os
      5.378 clientes ativos — nada escreve nela. O `Person` do Zen já traz
      `zipcode`/`street`/`number`/`complement`/`district`/`city`, e o
      `personAddress` é entidade relacionada para endereços adicionais.
      Sem isso, a tela de cadastro mostra vazio e o pedido não tem endereço de
      entrega confirmável.

---

## 8. Pedido Hub → ZEN: como a venda é montada, conferida e acompanhada (2026-11-25)

Tudo abaixo foi **medido** contra o ZEN de produção (vendas temporárias criadas,
lidas de volta e apagadas; e pedidos reais conferidos na tela do ZEN com o login do
André). Fonte única do código: `api/push-pedido.js` (pedido) e `api/_orcamento.js`
(orçamento), ambos usando `api/_zen_venda.js`.

### 8.1 Mapa de campos (Hub → `sale.Sale`)

| Dado no Hub | Campo no ZEN | Tela do ZEN |
|---|---|---|
| `ordem_compra` (se alguém digitou) | `code` | **Código** (= nº do pedido de compra do cliente) |
| `canal_venda` (canal do cliente: Varejo/Hibrido/Ecommerce) | `properties.salesChannel` | **Canal de vendas** |
| `dias_pagamento` → `"30/60"` | `properties.paymentMethods` | **Formas de pagamento** (e cria as parcelas) |
| `frete_modalidade` | `freightType` | **Transporte → Tipo de frete** |
| representante do cliente | `personSalesperson` | **Vendedor** |
| endereço do cliente | `personAddressShipping` | **Endereço** |
| itens (`preco_final`, `quantidade`) | `saleItem.unitValue` / `quantity` | itens (preço **com** desconto) |
| classe aplicada | `tags` (`F3`, `H2`, `E1`) | **Tags** |
| tudo que não tem campo | `properties.comments` | **Observações** |

`properties.salesHub` ("Hub de integração") **não é preenchido**: no ZEN só os
marketplaces o usam (valor = nome do marketplace). Não foi pedido para o Hub.

### 8.2 Parcelas: `paymentMethods` é a FONTE, não o contrário

- `POST /sale/sale` com `properties.paymentMethods: "30/60"` e **sem** `salePayment`
  → o ZEN cria as 2 parcelas (prazos 30 e 60). `PUT` trocando para `"28/56/84"` refaz as parcelas.
  `"0"` → 1 parcela à vista.
- Postar **só** `salePayment` cria as parcelas mas **deixa "Formas de pagamento" vazio**
  (era o que o ADM via em branco nos pedidos 60008/60088).
- Postar **os dois** **duplica** as parcelas (6 linhas para um 28/56/84).
- Cartão e Credix saem como 1 parcela à vista (quem financia é a adquirente); o parcelamento
  real não aparece no ZEN — decisão com o financeiro ainda em aberto.

### 8.3 Frete

| Hub (`frete_modalidade`) | `freightType` | Texto na tela do ZEN |
|---|---|---|
| CIF | `ISSUER` | EMITENTE |
| FOB | `RECIPIENT` | DESTINATARIO |
| RETIRADA_BOXER | `RECIPIENT_SELF` | **DESTINATARIO (PRÓPRIO)** (medido) |
| CARRO_BOXER, CAMINHAO_BOXER_SP | `ISSUER_SELF` | EMITENTE (PRÓPRIO) *(inferido, não visto na tela)* |

A spec pública do ZEN lista só `NONE|ISSUER|RECIPIENT`, mas o ZEN aceita 5 valores
(valor inválido → 500 `No enum constant ...FreightType.XXXX`). O ADM já usa `RECIPIENT_SELF`.

### 8.4 Texto das Observações (uma linha por dado, só o que existir)

Observação digitada pelo cliente → `Frete: <opção> — cobrado R$ X na nota` (ou "sem cobrança")
→ `Desconto: R$ X (Y%) sobre a tabela — classe N (Segmento/UF)` → `Item SKU (N un): exceção de preço —
desconto de P% — de R$ A por R$ B` → `Pedido feito por: <nome> (representante|funcionário Boxer|cliente)`
→ `Entrega agendada: sim` → `Exceção aprovada: ...` → `Faturamento parcial: aceita|NÃO aceita`
(só quando o onboarding do cliente registrou). **Forma de pagamento, OC e canal NÃO entram aqui** —
vão nos campos certos. Previsão de reposição e link do pedido: fora (decisão do André).

Preço: o ZEN recebe **só o preço final com desconto**. No cliente Híbrido/Ecommerce o preço da
revenda é *maior* que a tabela base (markup), então `preco_unitario` (tabela base) não serve de
"de" do desconto; o "de" é reconstruído de `preco_final / (1 − desconto_item_percentual)`.

### 8.5 Conferência automática (`conferirVenda`)

Depois de criar a venda, o Hub **lê de volta** e compara frete, formas, parcelas, itens (produto,
quantidade, valor), vendedor, endereço, observações, `code` e canal. O que divergir é corrigido por
`PUT /sale/sale` (objeto inteiro) e, se preciso, parcela a parcela. Nunca bloqueia o pedido; deixa na
timeline **"Conferido no ERP"**, **"Corrigido no ERP"** ou **"Divergência no ERP"**.
Cuidados medidos: leitura de listas pequenas pode repetir registros (deduplicar por `id`); `PUT` sem
nenhuma mudança devolve 400 (só se faz PUT quando há divergência).

### 8.6 Por que o pedido do representante chegava sem frete e sem pagamento

`hub_pedidos` não tem policy de UPDATE para `tipo='representante'`. O `PATCH` do checkout alterava
**0 linhas e devolvia sucesso**; `hub_fn_submeter_pedido` (SECURITY DEFINER) submetia assim mesmo e o push
lia tudo vazio. Correção: `hub_fn_salvar_detalhes_pedido` (migration `20261125190000`). Reproduzido no banco
como a Cristina (PATCH antigo = 0 linhas; função nova grava todos os campos), em transação desfeita.

### 8.7 Acompanhamento até o faturamento

- Etapas do workflow chegam ao Hub por `api/sync-pedidos-zen.js` (cron de 15 min, 06h–19h45 BRT, não é
  instantâneo) e viram eventos em `hub_pedido_eventos` (uma por etapa — índice único `pedido_id,etapa`).
- **Pedidos importados do ZEN** vinham sem histórico (5.188 de 5.889) e com a data da importação.
  `api/_historico_etapas.js` traz `sale.date` e os `workpieceNode` (com `dateTimeStart`); drena 200 por rodada
  (`erp_historico_em IS NULL` = pendente; em 26/11 às 10h: 3.080 de 5.989 prontos, 51%). A fila de acompanhamento agora é justa (pedidos abertos, checados há
  mais tempo primeiro) — antes eram só os 200 mais recentes.
- **Faturado** = primeira nota fiscal ligada ao pedido (`trg_hub_evento_faturado`; data = emissão da NF).
- **Entrega NÃO tem rastreio real ainda.** `status='entregue'` hoje vem de `servedQuantity`; não é confirmação de
  entrega. Pendente.

### 8.8 Como testar sem sujar a produção

1. Venda **temporária** no ZEN (`POST` → ler → `DELETE`; só `PREPARING` apaga) com tag `TESTE-...` e pessoa de teste.
2. Pedido real pela tela com o admin, depois apagar a venda e devolver o crédito com
   `select comercial.hub_fn_liberar_credito_rejeitado(id)` (respeita grupo) — **não** `hub_fn_reverter_pedido`
   (só vale antes de existir `erp_pedido_id`). Conferir limites antes/depois.
3. Boleto exige limite ativo e sem título vencido. Para teste pontual: regra de exceção `prazo_especial` com
   `liberar_elegibilidade=true` só para o `cliente_id`, vigência de 1 dia, **apagada em seguida**
   (`hub_regras_comerciais`) — nunca alterar a regra para todos.
4. Conferir **na tela do ZEN** (`sale/sale-edit?id=<id>`; a busca exige o campo Empresa), não só pela API.

### 8.9 Em aberto

- Retirada/FOB ainda cobra o frete da política (R$ 120 abaixo do mínimo) no Hub: decisão de negócio.
- Rastreio de entrega; parcelamento do cartão no contas a receber; boleto multi-parcela e login de
  representante **pela tela** ainda não provados de ponta a ponta.

### 8.10 Operação: o Hub parou por limite da Vercel (26/11/2026)

- Em 25/11 a Vercel pausou os deploys do time por **Fluid Active CPU** acima do limite do plano Hobby
  (4 h/mês): site e API responderam **HTTP 402 `DEPLOYMENT_DISABLED`** e o cron do sync falhou
  ("sync-pedidos-zen respondeu 402"). O time passou para o plano **Pro** e o Hub voltou (site 200, API 405).
- O time tem 5 projetos que dividem o mesmo limite; **não está confirmado qual consumiu mais** (ver Usage por
  projeto no painel). Um deles, `travel-intelligence`, foi **pausado** por decisão do André.
- Para um cron de 15 min com função de até 120 s (`api/sync-pedidos-zen.js`), o custo de CPU importa:
  não aumentar lote/frequência sem olhar o consumo, preferir trabalho pesado fora da Vercel (GitHub Actions),
  e evitar deploys por CLI em excesso.
- Como saber que caiu: a rodada do GitHub Actions falha com `HTTP 402` e `curl https://hub.boxersoldas.com.br` devolve 402.
