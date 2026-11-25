-- hub_fn_reverter_pedido registra acao 'reverter_pedido', que nao estava na
-- lista permitida. A constraint ja aceita acoes de dominio (ativacao_cliente,
-- avancar_etapa, convite_criado), entao esta pertence ao mesmo conjunto.
-- Alteracao apenas aditiva: nenhum valor que era aceito deixa de ser.
ALTER TABLE comercial.hub_log_alteracoes
  DROP CONSTRAINT hub_log_alteracoes_acao_check;

ALTER TABLE comercial.hub_log_alteracoes
  ADD CONSTRAINT hub_log_alteracoes_acao_check
  CHECK (acao = ANY (ARRAY[
    'insert'::text,
    'update'::text,
    'delete'::text,
    'ativacao_cliente'::text,
    'rejeicao_onboarding'::text,
    'avancar_etapa'::text,
    'convite_criado'::text,
    'liberar_acesso'::text,
    'reverter_pedido'::text
  ]));