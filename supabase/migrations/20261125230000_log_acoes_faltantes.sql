-- hub_log_alteracoes_acao_check nunca aceitou tres acoes que o codigo grava:
--  * liberar_credito_rejeitado  (hub_fn_liberar_credito_rejeitado): o INSERT no log
--    falhava e, por ser a mesma transacao, o credito de pedido reprovado no Zen NUNCA
--    era devolvido (desde 2026-10-27). Achado em 2026-11-25 ao limpar pedidos de teste.
--  * cancelamento_onboarding    (admin.html, cancelar cadastro): o PATCH ja tinha
--    acontecido e o erro do log interrompia o resto (aviso ao representante, toast).
--  * convite_aceito             (api/convite.js).
-- Mesmo padrao do bug do log de usuarios de 2026-11-25 (CHECK sem os valores novos).
-- Mantem todos os valores anteriores.
alter table comercial.hub_log_alteracoes
  drop constraint hub_log_alteracoes_acao_check;

alter table comercial.hub_log_alteracoes
  add constraint hub_log_alteracoes_acao_check
  check (acao = any (array[
    'insert', 'update', 'delete',
    'ativacao_cliente', 'rejeicao_onboarding', 'avancar_etapa',
    'convite_criado', 'liberar_acesso', 'reverter_pedido',
    'ativar_usuario', 'desativar_usuario', 'resetar_senha',
    'liberar_credito_rejeitado', 'cancelamento_onboarding', 'convite_aceito'
  ]));
