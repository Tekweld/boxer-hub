-- Documentacao no proprio banco (COMMENT) do que foi criado/descoberto em 2026-11-25,
-- para quem abrir o Supabase sem ler o repositorio. Sem efeito funcional.

comment on column comercial.hub_pedidos.canal_venda is
  'Canal do CLIENTE no momento do pedido (Varejo / Hibrido / Ecommerce). Preenchido por trg_hub_pedido_canal_venda. Vai para "Canal de vendas" (properties.salesChannel) da venda no ZEN.';
comment on column comercial.hub_pedidos.criado_por is
  'auth.uid() de quem montou o pedido (representante, funcionario ou cliente). Usado no texto "Pedido feito por" das observacoes da venda no ZEN.';
comment on column comercial.hub_pedidos.erp_historico_em is
  'Quando o historico de etapas (workpieceNode) e a data real (sale.date) do pedido importado do ZEN foram trazidos. NULL = pendente; api/_historico_etapas.js drena em lotes pelo cron sync-pedidos-zen.';
comment on column comercial.hub_pedidos.ordem_compra is
  'Numero do pedido de compra DO CLIENTE, digitado no Hub. Vai para o campo "Codigo" (sale.code) da venda no ZEN.';
comment on column comercial.hub_pedidos.frete_modalidade is
  'CIF | FOB | RETIRADA_BOXER | CARRO_BOXER | CAMINHAO_BOXER_SP. Mapeia para sale.freightType: CIF=ISSUER, FOB=RECIPIENT, RETIRADA_BOXER=RECIPIENT_SELF, CARRO/CAMINHAO_BOXER=ISSUER_SELF (api/_zen_venda.js).';
comment on column comercial.hub_pedidos.dias_pagamento is
  'Prazo em dias de cada parcela (ex.: {30,60}). Vai para sale.properties.paymentMethods ("30/60"); o ZEN cria as parcelas (salePayment) sozinho a partir desse campo.';

comment on function comercial.hub_fn_salvar_detalhes_pedido(uuid, jsonb) is
  'Grava forma de pagamento, parcelas, dias, frete, OC, observacoes e classe/UF do rascunho. SECURITY DEFINER porque o representante NAO tem UPDATE em hub_pedidos (o PATCH direto afetava 0 linhas sem erro). Valida: pedido rascunho, cliente nao bloqueado e dono (cliente/carteira do rep/staff).';
comment on function comercial.hub_trg_evento_faturado() is
  'Cria o evento "Faturado" na linha do tempo (data de emissao da NF) e muda aprovado/em_separacao para faturado quando uma nota fiscal e ligada a um pedido.';
comment on function comercial.hub_trg_pedido_canal_venda() is
  'BEFORE INSERT em hub_pedidos: copia hub_clientes.canal para hub_pedidos.canal_venda quando ninguem informou.';
comment on function comercial.hub_trg_liberar_credito_pedido() is
  'Rede de seguranca: devolve credito (pelo helper de grupo, com teto) so quando um pedido do Hub reservado vira cancelado. Rejeicao NAO passa aqui: hub_fn_liberar_credito_rejeitado ja devolve (a versao antiga devolvia em dobro).';
comment on function comercial.hub_fn_liberar_credito_rejeitado(uuid) is
  'Devolve o credito reservado (respeitando grupo) e marca o pedido como rejeitado. Chamada pelo sync quando o ZEN reprova o pedido.';

comment on constraint hub_log_alteracoes_acao_check on comercial.hub_log_alteracoes is
  'TODA acao nova gravada em hub_log_alteracoes (SQL, api/*.js ou html) precisa entrar aqui: o INSERT falha e derruba a operacao inteira se nao estiver na lista (bug repetido em 2026-11-25: usuarios, credito rejeitado, cancelamento de onboarding, convite aceito).';

comment on index comercial.hub_pedido_eventos_unico is
  'Uma etapa por pedido (pedido_id, etapa): repeticoes sao descartadas com on_conflict ... ignore-duplicates. Por isso etapas que se repetem no ZEN aparecem uma vez.';
