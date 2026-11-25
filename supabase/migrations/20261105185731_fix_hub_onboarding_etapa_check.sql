-- BUG CRITICO achado em 2026-11-06, investigando onde notificar o
-- representante: o admin.html usa etapa_atual = 'aprovacao_adm',
-- 'aprovacao_financeiro' e 'cancelado' em varios botoes (avancarOnb,
-- aprovarCredito, confirmarCancelamento), mas a CHECK constraint da tabela
-- NUNCA permitiu esses valores (so tinha 'aprovacao_adm_vendas', sem
-- 'aprovacao_financeiro' nem 'cancelado'). Confirmado contra o banco real:
-- nenhum onboarding JAMAIS teve esses valores gravados -- toda tentativa de
-- avancar passado "Aprovar Dados + Docs", aprovar credito ou cancelar
-- sempre deu erro de constraint, direto pro usuario via toast. Pipeline de
-- aprovacao estava quebrado no meio desde que foi construido.
alter table comercial.hub_onboarding drop constraint hub_onboarding_etapa_check;
alter table comercial.hub_onboarding add constraint hub_onboarding_etapa_check
  check (etapa_atual = any (array[
    'formulario','validacao_ia','aprovacao_docs','aprovacao_adm','aprovacao_adm_vendas',
    'analise_credito','aprovacao_financeiro','aprovacao_credito',
    'ativacao','ativo','rejeitado','cancelado'
  ]));
