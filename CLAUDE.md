# CLAUDE.md — Boxer Hub (Plataforma Comercial B2B)

Portal B2B para revendedores Boxer Soldas. Schema `comercial` no Supabase `boxer-sistemas`, prefixo `hub_`.

---

## SUPABASE

```
URL:  https://bmepxcnrsofofoswubuu.supabase.co
ANON: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXB4Y25yc29mb2Zvc3d1YnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTczNzMsImV4cCI6MjA5NTI5MzM3M30.S55ouFczRYlUYNFf5PotYKXBPT5idypTSmbzR-x2Pk0
```

Nunca usar service_role key no codigo. Anon key e segura para frontend.

---

## ARQUIVOS

| Arquivo | Funcao |
|---|---|
| `hub.js` | Funcoes compartilhadas: auth (login/logout/refresh), sb() fetch wrapper, toast(), topbar, constantes Supabase |
| `index.html` | Tela de login |
| `catalogo.html` | Vitrine de produtos: grid, filtro por categoria, PDP (ficha tecnica, fotos, docs), busca |
| `pedidos.html` | Criar pedido (carrinho), listar pedidos, detalhe, acompanhar status |
| `financeiro.html` | Titulos (abertos/vencidos), notas fiscais (download XML/PDF), boletos, solicitar credito |
| `cadastro.html` | Dados do cliente (read-only), enderecos, documentos cadastrais, solicitacao de alteracao |
| `admin.html` | Painel admin: usuarios/perfis, campanhas, regras comerciais, tabelas de preco, pesquisas |
| `pesquisas.html` | Pesquisas ativas para o revendedor responder |
| `netlify.toml` | Config de deploy Netlify |
| `docs/` | Documentacao de planejamento (NAO MEXER) |
| `mvp/` | Prototipo antigo de referencia (NAO MEXER) |

**Regra:** cada pagina HTML inclui `<script src="hub.js"></script>` e usa as funcoes compartilhadas. CSS inline no proprio HTML (padrao Boxer). Nunca criar arquivos CSS separados.

---

## TABELAS hub_ (schema comercial)

### SYNC — preenchidas pelo conector ZEN. Frontend so le (SELECT).

| Tabela | Colunas-chave | Uso |
|---|---|---|
| `hub_clientes` | cnpj, razao_social, nome_fantasia, status_cadastro, limite_credito, limite_disponivel, tabela_preco_id, representante_id, erp_cliente_id | Cadastro do revendedor |
| `hub_representantes` | nome, email, regiao, meta_mensal, comissao_percentual, erp_representante_id | Representantes comerciais |
| `hub_enderecos` | cliente_id, tipo (principal/entrega/cobranca), cep-logradouro-cidade-uf | Enderecos do cliente |
| `hub_produtos` | sku, nome, descricao, ncm, categoria_id, estoque_disponivel, estoque_minimo, previsao_chegada, ficha_tecnica (jsonb), erp_produto_id | Catalogo de produtos |
| `hub_titulos` | cliente_id, numero_titulo, valor_original, valor_aberto, data_vencimento, status (aberto/vencido/pago), dias_atraso, url_boleto | Titulos financeiros |
| `hub_notas_fiscais` | cliente_id, numero_nf, chave_acesso, data_emissao, valor_total, xml_path, pdf_path | Notas fiscais |

### NATIVA — criadas pelos usuarios via frontend.

| Tabela | Colunas-chave | Uso |
|---|---|---|
| `hub_perfis` | user_id, tipo (cliente/representante/funcionario/admin), role (dealer/rep/analyst/manager/financial/admin), nome, email, cliente_id, representante_id | Perfil do usuario autenticado |
| `hub_carteira` | representante_id, cliente_id, data_vinculo | Vinculo rep-cliente (admin configura) |
| `hub_pedidos` | numero (HUB-2026-00001), cliente_id, representante_id, status (rascunho→submetido→aprovado→faturado→enviado→entregue), origem, valor_total, ordem_compra | Pedidos |
| `hub_pedido_itens` | pedido_id, produto_id, quantidade, preco_unitario, preco_final, subtotal_item | Itens do pedido |
| `hub_notificacoes` | usuario_id, tipo, titulo, mensagem, referencia_tipo, referencia_id, lida | Notificacoes do sistema |
| `hub_solicitacoes_credito` | cliente_id, solicitante_id, tipo (aumento_limite/antecipacao/prazo_especial), valor_solicitado, status (pendente→aprovado/rejeitado) | Pedidos de credito |
| `hub_documentos_cadastrais` | cliente_id (nullable), onboarding_id, tipo (contrato_social/cartao_cnpj/etc), storage_path, status (pendente→aprovado/rejeitado) | Uploads de documentos (cliente ou onboarding) |
| `hub_produto_anexos` | produto_id, tipo (foto/ficha_tecnica/certificado/fispq/manual/catalogo), storage_path, ordem | Fotos e docs de produtos |
| `hub_pesquisa_respostas` | pesquisa_id, pergunta_id, respondente_id, resposta_texto, resposta_numero | Respostas dos revendedores |
| `hub_log_alteracoes` | usuario_id, usuario_email, tabela_ref, registro_id, campo, valor_anterior, valor_novo, acao | Log de auditoria |
| `hub_log_autenticacao` | usuario_id, email, evento (login_sucesso/login_falha/logout/etc), ip_address | Log de auth |

### ONBOARDING — pipeline de cadastro de novos clientes.

| Tabela | Colunas-chave | Uso |
|---|---|---|
| `hub_onboarding` | cnpj, razao_social, contato_email, etapa_atual (formulario→validacao_ia→aprovacao_docs→analise_credito→aprovacao_credito→ativacao→ativo), docs_status, credito_status, aprovador_docs_id, aprovador_credito_id, limite_sugerido, limite_aprovado, classificacao, tabela_preco_sugerida, resultado_validacao_ia (jsonb), dados_preenchidos_ia (jsonb), enderecos (jsonb), cliente_id, user_id, erp_cliente_id | Pipeline de onboarding (clientes novos) |
| `hub_convites` | cliente_id, email, token (uuid unique), status (pendente/aceito/expirado/cancelado), criado_por, user_id, expira_em | Convites para clientes existentes (ja estao no ZEN/hub_clientes) |
| `hub_analise_credito` | onboarding_id (nullable), solicitacao_id (nullable), cliente_id (nullable), fonte (manual/vadoo/serasa/credix), score, limite_sugerido, dados_brutos (jsonb), parecer, analisado_por | Analise de credito (serve onboarding E aumento de limite) |

**Dois fluxos de ativacao:**
- **Cliente novo** (nao existe no ZEN): pipeline completo hub_onboarding (formulario → IA → ADM → credito → financeiro → ZEN → ativacao)
- **Cliente existente** (ja no ZEN/hub_clientes): admin cria convite → email com link → cliente aceita e define senha → ativo. Limite de credito ja vem do ZEN.

**Aumento de limite:** Mesmo fluxo para novos e existentes — hub_solicitacoes_credito + hub_analise_credito → financeiro aprova.

### CONFIG — admin configura via painel.

| Tabela | Colunas-chave | Uso |
|---|---|---|
| `hub_categorias` | nome, slug, categoria_pai_id, ordem | Categorias do catalogo |
| `hub_tabela_precos` | nome, codigo, tipo (padrao/segmento/promocional), vigencia_inicio/fim | Tabelas de preco |
| `hub_tabela_preco_itens` | tabela_preco_id, produto_id, preco_base, preco_minimo, desconto_maximo_percentual, ipi, icms | Precos por produto |
| `hub_regras_comerciais` | nome, tipo, condicao (jsonb), acao (jsonb), vigencia | Regras do CIE (motor comercial) |
| `hub_campanhas` | nome, tipo (promocao/lancamento/etc), data_inicio/fim, segmentos_alvo | Campanhas promocionais |
| `hub_campanha_produtos` | campanha_id, produto_id, preco_promocional, desconto_percentual, quantidade_limite | Produtos em campanha |
| `hub_pesquisas` | titulo, tipo (satisfacao/nps/etc), status (rascunho/ativa/encerrada), anonima | Pesquisas para revendedores |
| `hub_pesquisa_perguntas` | pesquisa_id, texto, tipo_resposta (texto/escala/multipla_escolha/nota_1_10), opcoes, ordem | Perguntas da pesquisa |

---

## VIEWS

| View | Retorna | Usada em |
|---|---|---|
| `hub_v_catalogo` | Produto + categoria + contagem de fotos + status_estoque + backorder_disponivel | catalogo.html |
| `hub_v_preco_cliente` | Preco efetivo por cliente (tabela + promocao ativa) | pedidos.html, catalogo.html |
| `hub_v_financeiro_cliente` | Resumo: titulos abertos/vencidos, totais, maior atraso | financeiro.html |
| `hub_v_notif_pendentes` | Notificacoes nao lidas com horas_atras | topbar (hub.js) |

---

## FUNCOES SQL

| Funcao | Parametros | Retorna | Quando usar |
|---|---|---|---|
| `hub_fn_submeter_pedido(pedido_id)` | uuid do pedido | `{ok, numero, valor_total, itens}` | Ao submeter pedido (muda rascunho→submetido, gera numero, calcula totais) |
| `hub_fn_calcular_preco(cliente_id, produto_id, quantidade)` | uuids + int | `{ok, preco_base, preco_final, preco_minimo, ipi, icms, em_promocao, subtotal}` | Ao adicionar item ao carrinho |
| `hub_fn_validar_credito(cliente_id, valor)` | uuid + numeric | `{ok, limite_total, disponivel, disponivel_apos}` ou erro | Antes de submeter pedido |
| `hub_fn_gerar_numero()` | — | `'HUB-2026-00001'` | Chamada internamente por hub_fn_submeter_pedido |

**Helper RLS (security definer, nao chamar diretamente):**
`hub_user_role()`, `hub_user_tipo()`, `hub_user_cliente_id()`, `hub_user_representante_id()`

---

## RLS — QUEM VE O QUE

| Tipo usuario | Catalogo | Pedidos | Financeiro | Cadastro | Admin |
|---|---|---|---|---|---|
| **dealer** (cliente) | Todos produtos, SEU preco | Seus pedidos | Seus titulos/NFs | Seu cadastro (read-only) | — |
| **rep** (representante) | Todos produtos | Pedidos da carteira | Titulos da carteira | Clientes da carteira | — |
| **analyst** | Todos | Todos | — | Todos | Campanhas, pesquisas, precos |
| **manager** | Todos | Todos (aprovar) | Todos | Todos | Tudo exceto usuarios |
| **financial** | — | — | Todos | — | — |
| **admin** | Todos | Todos | Todos | Todos | Tudo |

---

## REGRAS ABSOLUTAS

1. **Nunca alterar tabelas existentes** do schema comercial que NAO tenham prefixo `hub_` (propostas, comercial_bmax_*, comercial_tarefas, etc.)
2. **CSS inline** no proprio HTML — nunca criar arquivo .css separado
3. **hub.js** e o unico arquivo JS compartilhado — funcoes comuns vao la
4. **Nunca hardcodar service_role key** — usar apenas anon key no frontend
5. **Fonte Outfit** — importar via Google Fonts link no head de cada HTML
6. **Paleta Boxer** — navy #1d327b, cyan #25bbee, red #e30613, bg #f0f4f8
7. **Primeiro admin** — inserir via painel Supabase (bypassa RLS)
8. **Tabelas SYNC** — frontend so faz SELECT. Escrita apenas via conector/service_role.
9. **Nao mexer** em docs/ e mvp/ — sao referencia, nao codigo ativo

---

## 4 TIPOS DE USUARIO

| Tipo | Role | Portal | Identifica por |
|---|---|---|---|
| Cliente (revendedor) | dealer | Catalogo, pedidos, financeiro, cadastro | `hub_user_tipo() = 'cliente'` |
| Representante | rep | Pedidos (proxy), carteira de clientes | `hub_user_tipo() = 'representante'` |
| Funcionario Boxer | analyst, manager, financial | ADM vendas, financeiro | `hub_user_tipo() = 'funcionario'` |
| Admin | admin | Tudo | `hub_user_role() = 'admin'` |

---

## FLUXO DE PEDIDO

```
rascunho → submetido → em_analise → aprovado → em_separacao → faturado → enviado → entregue
                                   ↘ rejeitado
                    ↘ cancelado (dealer pode cancelar rascunho)
```

Trigger `trg_hub_notif_status` gera notificacao automatica ao mudar status.
Trigger `trg_hub_atualizar_credito` ajusta limite ao aprovar solicitacao de credito.

---

## MEMORIA DO PROJETO (Claude Code) — LER ANTES DE COMECAR

Este projeto mantem **memoria persistente do Claude Code**, fora do repo. Ela
guarda o que o codigo nao conta: decisoes de negocio e o porque delas, o que ja
foi tentado e revertido, armadilhas que custaram tempo, e a fila de proximos
passos. **Comece por ela, nao pelo codigo.**

**Sao DOIS diretorios de memoria**, porque o mesmo repo esta clonado em mais de
uma pasta local, e cada pasta gera a sua:

```
%USERPROFILE%\.claude\projects\
  C--Users-<user>-BOXER-Dados---Documentos-Comercial-Geral-Tabelas-de-Pre-os-Plataforma-Comercial\memory\
  C--Users-<user>-BOXER-Fileserver---Documentos-COMERCIAL-Gestor-hub-comercial\memory\
```

Em cada um, `MEMORY.md` e o indice. Regras de uso:

1. **Ler os dois `MEMORY.md`** no inicio da sessao. O primeiro esta mais
   atualizado sobre pedido/integracao Zen; o segundo tem a **formula de preco**
   e o historico do catalogo.
2. **Ao decidir algo novo, registrar** — e, se valer para os dois, escrever nos
   dois lados ou anotar que o outro precisa de atualizacao.
3. **Divergiu?** A data em `metadata.modified` do arquivo decide.
4. `docs/` neste repo e **intencao registrada, nao estado**. Quando doc e
   codigo divergirem, o codigo e o que esta no ar — mas a divergencia pode ser
   bug, entao confirmar com o Andre antes de assumir que a doc envelheceu.
5. **Trabalho concorrente e real** (Ayrton + outras sessoes, mesmo repo e mesmo
   banco). Sempre `git fetch` e `git log HEAD..origin/main` antes de mexer, e
   comparar migrations locais com `supabase_migrations.schema_migrations`.

A memoria e local da maquina do Andre e **nao e versionada aqui** — este bloco
existe so para que qualquer sessao saiba que ela existe e onde procurar.
