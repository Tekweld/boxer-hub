-- Pedido do Andre, 25/11: tela de Usuarios ganhou acoes diretas de
-- ativar/desativar/resetar senha. O INSERT de log falhava silenciosamente
-- (CHECK constraint so aceitava um vocabulario fixo de acao, sem essas tres)
-- -- achado testando ao vivo o endpoint real (log nunca aparecia), nao so
-- por leitura de codigo.
alter table comercial.hub_log_alteracoes
  drop constraint hub_log_alteracoes_acao_check;

alter table comercial.hub_log_alteracoes
  add constraint hub_log_alteracoes_acao_check
  check (acao = any (array[
    'insert', 'update', 'delete',
    'ativacao_cliente', 'rejeicao_onboarding', 'avancar_etapa',
    'convite_criado', 'liberar_acesso', 'reverter_pedido',
    'ativar_usuario', 'desativar_usuario', 'resetar_senha'
  ]));
